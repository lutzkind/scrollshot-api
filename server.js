import Fastify from 'fastify';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const app = Fastify({ logger: true, trustProxy: true });
const PORT = Number(process.env.PORT || 3199);
const PLAYWRIGHT_CHANNEL = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
const CHROME_BIN = process.env.CHROME_BIN || '';
const API_KEYS = new Set(
  String(process.env.API_KEYS || process.env.API_KEY || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 30);
const rateLimitBuckets = new Map();

const IMAGE_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

const VIDEO_MIME = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  gif: 'image/gif',
};

const SUPPORTED_EASINGS = new Set([
  'linear',
  'ease_in_quad',
  'ease_out_quad',
  'ease_in_out_quad',
  'ease_in_cubic',
  'ease_out_cubic',
  'ease_in_out_cubic',
  'ease_in_quart',
  'ease_out_quart',
  'ease_in_out_quart',
  'ease_in_quint',
  'ease_out_quint',
  'ease_in_out_quint',
]);

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function toInt(value, fallback, { min, max } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
}

function toFloat(value, fallback, { min, max } = {}) {
  const parsed = Number.parseFloat(String(value ?? ''));
  if (Number.isNaN(parsed)) return fallback;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
}

function ensureEven(value) {
  return value % 2 === 0 ? value : value + 1;
}

function normalizeFormat(value) {
  const format = String(value || 'png').trim().toLowerCase();
  if (format === 'jpg') return 'jpeg';
  return format;
}

function normalizeWaitUntil(value) {
  const candidate = String(value || '').trim().toLowerCase();
  if (candidate === 'networkidle0' || candidate === 'networkidle2') {
    return 'networkidle';
  }
  if (['load', 'domcontentloaded', 'networkidle', 'commit'].includes(candidate)) {
    return candidate;
  }
  return null;
}

function pickWaitUntilSequence(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const normalized = rawValues
    .map((entry) => normalizeWaitUntil(entry))
    .filter(Boolean);

  if (normalized.length === 0) {
    return ['networkidle'];
  }

  return [...new Set(normalized)];
}

function normalizePreset(value) {
  const preset = String(value || 'medium').trim().toLowerCase();
  if (['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].includes(preset)) {
    return preset;
  }
  return 'fast';
}

function normalizeEasing(value) {
  const easing = String(value || 'ease_in_out_cubic').trim().toLowerCase();
  if (SUPPORTED_EASINGS.has(easing)) {
    return easing;
  }
  return 'ease_in_out_quint';
}

function readApiKey(request) {
  const headerValue = request.headers['x-api-key'];
  if (headerValue) return String(headerValue);

  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const queryValue = request.query?.api_key;
  if (queryValue) return String(queryValue);

  return '';
}

function enforceRateLimit(request) {
  const now = Date.now();
  const ip = request.ip || 'unknown';
  const bucket = rateLimitBuckets.get(ip);

  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(ip, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return;
  }

  if (bucket.count >= RATE_LIMIT_MAX) {
    const error = new Error('Rate limit exceeded');
    error.statusCode = 429;
    error.retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    throw error;
  }

  bucket.count += 1;
}

function assertUrl(target) {
  if (!target) throw new Error('Missing required query parameter: url');
  const parsed = new URL(String(target));
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported');
  }
  return parsed.toString();
}

function buildOptions(query) {
  const format = normalizeFormat(query.format || 'mp4');
  const videoRequested = ['webm', 'mp4', 'gif'].includes(format);
  const scenario = String(query.scenario || '').trim().toLowerCase();
  const waitUntilSequence = pickWaitUntilSequence(query.wait_until);
  const viewportWidth = toInt(query.viewport_width ?? query.viewportWidth, 1280, { min: 320, max: 3840 });
  const viewportHeight = toInt(query.viewport_height ?? query.viewportHeight, 720, { min: 320, max: 3840 });
  const deviceScaleFactor = toFloat(
    query.device_scale_factor ?? query.scale_factor,
    videoRequested ? 1 : 1,
    { min: 1, max: 3 },
  );
  const defaultOutputWidth = videoRequested
    ? viewportWidth
    : Math.round(viewportWidth * deviceScaleFactor);
  const defaultOutputHeight = videoRequested
    ? viewportHeight
    : Math.round(viewportHeight * deviceScaleFactor);
  const outputWidth = ensureEven(toInt(query.width, defaultOutputWidth, { min: 320, max: 4096 }));
  const outputHeight = ensureEven(toInt(query.height, defaultOutputHeight, { min: 320, max: 4096 }));
  const defaultTotalDurationMs = toInt(query.animation_duration, 9000, { min: 1000, max: 120000 });
  const totalDurationMs = query.duration !== undefined
    ? toInt(query.duration, 5, { min: 1, max: 120 }) * 1000
    : defaultTotalDurationMs;
  const scrollingRequested = toBoolean(query.full_page_scroll, false)
    || toBoolean(query.animate, false)
    || toBoolean(query.scrolling_screenshot, false)
    || scenario === 'scroll'
    || videoRequested;

  return {
    targetUrl: assertUrl(query.url),
    format,
    viewportWidth,
    viewportHeight,
    outputWidth,
    outputHeight,
    deviceScaleFactor,
    fullPage: toBoolean(query.full_page, true),
    preloadLazyContent: toBoolean(query.preload_lazy_content, true),
    waitUntil: waitUntilSequence[0],
    waitUntilSequence,
    navigationTimeoutMs: toInt(query.navigation_timeout, 45000, { min: 5000, max: 180000 }),
    delayMs: toInt(query.delay, 0, { min: 0, max: 120000 }),
    imageQuality: toInt(query.image_quality ?? query.quality, 92, { min: 1, max: 100 }),
    scrollingRequested,
    totalDurationMs,
    scrollDelayMs: toInt(query.scroll_delay, 500, { min: 0, max: 15000 }),
    scrollStepDurationMs: toInt(query.scroll_duration, 1500, { min: 120, max: 30000 }),
    scrollByPx: toInt(query.scroll_by, Math.max(Math.round(viewportHeight * 0.92), 640), { min: 100, max: 3000 }),
    scrollSteps: toInt(query.scroll_steps ?? query.scroll_count, scenario === 'scroll' ? 4 : 4, { min: 1, max: 12 }),
    scrollStartDelayMs: toInt(query.scroll_start_delay, 0, { min: 0, max: 30000 }),
    scrollStartImmediately: toBoolean(query.scroll_start_immediately, true),
    scrollBack: toBoolean(query.scroll_back, false),
    scrollComplete: toBoolean(query.scroll_complete, true),
    scrollBackAfterDurationMs: query.scroll_back_after_duration === undefined
      ? null
      : toInt(query.scroll_back_after_duration, 0, { min: 0, max: 120000 }),
    scrollStopAfterDurationMs: query.scroll_stop_after_duration === undefined
      ? null
      : toInt(query.scroll_stop_after_duration, totalDurationMs, { min: 0, max: 120000 }),
    scrollEasing: normalizeEasing(query.scroll_easing),
    scrollJitterPx: toInt(query.scroll_jitter_px, 42, { min: 0, max: 240 }),
    holdDurationMs: toInt(query.hold_duration, 0, { min: 0, max: 30000 }),
    ignoreHostErrors: toBoolean(query.ignore_host_errors, false),
    videoFps: toInt(query.video_fps ?? query.fps, 30, { min: 12, max: 60 }),
    videoCrf: query.video_crf ?? query.crf,
    videoBitrateKbps: toInt(query.video_bitrate_kbps ?? query.bitrate_kbps, 4000, { min: 800, max: 20000 }),
    videoPreset: normalizePreset(query.video_preset ?? query.preset),
    outputName: String(query.file_name || randomUUID()).replace(/[^a-zA-Z0-9._-]/g, '_'),
  };
}

async function launchBrowser() {
  const launchOptions = {
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
    ],
  };

  if (CHROME_BIN) {
    launchOptions.executablePath = CHROME_BIN;
  } else {
    launchOptions.channel = PLAYWRIGHT_CHANNEL;
  }

  return chromium.launch(launchOptions);
}

async function bestEffortNetworkIdle(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // Some pages never reach network idle; ignore.
  }
}

async function waitForRequestedStates(page, options) {
  const timeout = options.scrollingRequested ? 2500 : 8000;
  for (const state of options.waitUntilSequence.slice(1)) {
    try {
      await page.waitForLoadState(state, { timeout });
    } catch {
      // Best effort only. Some pages never settle into later states.
    }
  }
}

async function preloadLazyContent(page) {
  const viewportHeight = page.viewportSize()?.height || 720;
  let lastScrollY = -1;

  for (let i = 0; i < 60; i += 1) {
    const metrics = await page.evaluate(() => ({
      scrollHeight: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      ),
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
    }));

    if (metrics.scrollY + metrics.innerHeight >= metrics.scrollHeight - 2) break;
    if (metrics.scrollY === lastScrollY) break;

    lastScrollY = metrics.scrollY;
    await page.evaluate((nextY) => window.scrollTo({ top: nextY, behavior: 'auto' }), metrics.scrollY + viewportHeight);
    await page.waitForTimeout(250);
    await bestEffortNetworkIdle(page);
  }

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }));
  await page.waitForTimeout(250);
}

async function renderScreenshot(page, options) {
  return page.screenshot({
    type: options.format === 'jpg' ? 'jpeg' : options.format,
    fullPage: options.fullPage,
    quality: ['jpeg', 'webp'].includes(options.format) ? options.imageQuality : undefined,
    animations: 'disabled',
  });
}

function getEasingFunction(name) {
  const easingMap = {
    linear: (t) => t,
    ease_in_quad: (t) => t * t,
    ease_out_quad: (t) => 1 - (1 - t) * (1 - t),
    ease_in_out_quad: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
    ease_in_cubic: (t) => t ** 3,
    ease_out_cubic: (t) => 1 - (1 - t) ** 3,
    ease_in_out_cubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2),
    ease_in_quart: (t) => t ** 4,
    ease_out_quart: (t) => 1 - (1 - t) ** 4,
    ease_in_out_quart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - ((-2 * t + 2) ** 4) / 2),
    ease_in_quint: (t) => t ** 5,
    ease_out_quint: (t) => 1 - (1 - t) ** 5,
    ease_in_out_quint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - ((-2 * t + 2) ** 5) / 2),
  };
  return easingMap[name] || easingMap.ease_in_out_quint;
}

function buildFractions(count, targetCoverage) {
  const fractions = [];
  const midpoint = (count - 1) / 2;

  for (let index = 0; index < count; index += 1) {
    const progress = (index + 1) / count;
    const shaped = progress ** 0.92;
    const symmetry = midpoint === 0 ? 0 : (index - midpoint) / midpoint;
    const offset = symmetry * 0.012;
    fractions.push(Math.min(targetCoverage, Math.max(0.08, shaped * targetCoverage + offset)));
  }

  return fractions;
}

function buildDurations(count, budgetMs, pauseMs) {
  const weights = [1.05, 1.02, 0.98, 0.95, 0.92, 0.9, 0.88, 0.86];
  const chosen = Array.from({ length: count }, (_, index) => weights[index] ?? 0.84);
  const totalWeight = chosen.reduce((sum, entry) => sum + entry, 0);
  const basePauses = count > 1
    ? [0.9, 1.25, 0.78, 1.08, 0.88, 1.12, 0.82].slice(0, count - 1)
    : [];
  const pauseWeight = basePauses.reduce((sum, entry) => sum + entry, 0) || 1;

  return {
    scrolls: chosen.map((weight) => Math.round((budgetMs * weight) / totalWeight)),
    pauses: basePauses.map((weight) => Math.round((pauseMs * weight) / pauseWeight)),
  };
}

async function getScrollMetrics(page) {
  return page.evaluate(() => ({
    maxScroll: Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
    ) - window.innerHeight,
  }));
}

function buildScrollTimeline(maxScroll, options) {
  const totalDurationMs = options.totalDurationMs;
  const stepCount = Math.max(1, options.scrollSteps || 4);
  const startDelayMs = options.scrollStartImmediately ? 0 : options.scrollStartDelayMs;
  const scrollBackEnabled = options.scrollBack && options.scrollComplete;
  const scrollBackDurationMs = scrollBackEnabled
    ? Math.max(650, Math.round(options.scrollStepDurationMs * 0.72))
    : 0;
  const tailHoldMs = Math.min(options.holdDurationMs, Math.max(0, totalDurationMs - startDelayMs));
  const activeBudgetMs = Math.max(0, totalDurationMs - startDelayMs - tailHoldMs - scrollBackDurationMs);

  const targetCoverage = maxScroll <= 0
    ? 0
    : options.scrollComplete
      ? 1
      : Math.min(0.92, Math.max(0.74, (options.scrollByPx * stepCount) / Math.max(maxScroll, 1)));
  const fractions = buildFractions(stepCount, targetCoverage);
  const pauseBudgetMs = stepCount > 1
    ? Math.min(
        Math.max(0, activeBudgetMs * 0.16),
        Math.max(240, options.scrollDelayMs) * (stepCount - 1),
      )
    : 0;
  const scrollBudgetMs = Math.max(
    stepCount * 320,
    activeBudgetMs - pauseBudgetMs,
  );
  const budgets = buildDurations(stepCount, scrollBudgetMs, pauseBudgetMs);

  let currentMs = 0;
  let currentY = 0;
  const segments = [];

  if (startDelayMs > 0) {
    segments.push({ type: 'hold', startMs: currentMs, endMs: currentMs + startDelayMs, y: currentY });
    currentMs += startDelayMs;
  }

  for (let index = 0; index < stepCount; index += 1) {
    const plannedTarget = Math.round(maxScroll * fractions[index]);
    const minimumProgress = Math.round(currentY + Math.max(60, options.scrollByPx * 0.18));
    const nextY = Math.max(currentY, Math.min(maxScroll, Math.max(plannedTarget, minimumProgress)));
    const durationMs = Math.max(300, budgets.scrolls[index] ?? options.scrollStepDurationMs);

    if (nextY > currentY + 1 && currentMs < totalDurationMs) {
      const endMs = Math.min(totalDurationMs, currentMs + durationMs);
      segments.push({
        type: 'scroll',
        startMs: currentMs,
        endMs,
        startY: currentY,
        endY: nextY,
      });
      currentMs = endMs;
      currentY = nextY;
    }

    if (index < stepCount - 1 && currentMs < totalDurationMs) {
      const pauseMs = Math.max(0, budgets.pauses[index] ?? options.scrollDelayMs);
      if (pauseMs > 0) {
        const endMs = Math.min(totalDurationMs, currentMs + pauseMs);
        segments.push({ type: 'hold', startMs: currentMs, endMs, y: currentY });
        currentMs = endMs;
      }
    }
  }

  if (scrollBackEnabled && currentMs < totalDurationMs) {
    const endMs = Math.min(totalDurationMs, currentMs + scrollBackDurationMs);
    segments.push({
      type: 'scroll',
      startMs: currentMs,
      endMs,
      startY: currentY,
      endY: 0,
    });
    currentMs = endMs;
    currentY = 0;
  }

  if (currentMs < totalDurationMs) {
    segments.push({ type: 'hold', startMs: currentMs, endMs: totalDurationMs, y: currentY });
  }

  return segments;
}

function positionForTimestamp(segments, timeMs, easingFn) {
  const segment = segments.find((entry) => timeMs <= entry.endMs) || segments.at(-1);
  if (!segment) return 0;

  if (segment.type === 'hold' || segment.endMs <= segment.startMs) {
    return segment.y ?? segment.endY ?? 0;
  }

  const progress = Math.min(1, Math.max(0, (timeMs - segment.startMs) / (segment.endMs - segment.startMs)));
  const eased = easingFn(progress);
  return segment.startY + ((segment.endY - segment.startY) * eased);
}

async function encodeFrames(inputPattern, targetFormat, tmpDir, options) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available for transcoding');
  }

  const outputPath = path.join(tmpDir, `output.${targetFormat}`);
  const args = [
    '-y',
    '-framerate', String(options.videoFps),
    '-i', inputPattern,
  ];

  if (targetFormat === 'mp4') {
    const crfMode = options.videoCrf !== undefined && options.videoCrf !== null && String(options.videoCrf) !== '';
    const videoCrf = crfMode
      ? toInt(options.videoCrf, 18, { min: 12, max: 35 })
      : null;
    args.push(
      '-an',
      '-c:v', 'libx264',
      '-preset', options.videoPreset,
      '-tune', 'animation',
      '-profile:v', 'high',
      '-movflags', 'faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', `fps=${options.videoFps},scale=${options.outputWidth}:${options.outputHeight}:flags=lanczos`,
    );

    if (crfMode) {
      args.push('-crf', String(videoCrf));
    } else {
      args.push(
        '-b:v', `${options.videoBitrateKbps}k`,
        '-maxrate', `${Math.round(options.videoBitrateKbps * 1.2)}k`,
        '-bufsize', `${options.videoBitrateKbps * 2}k`,
      );
    }

    args.push(outputPath);
  } else if (targetFormat === 'webm') {
    const crfMode = options.videoCrf !== undefined && options.videoCrf !== null && String(options.videoCrf) !== '';
    const videoCrf = crfMode
      ? toInt(options.videoCrf, 28, { min: 18, max: 40 })
      : null;
    args.push(
      '-an',
      '-c:v', 'libvpx-vp9',
      '-row-mt', '1',
      '-pix_fmt', 'yuv420p',
      '-vf', `fps=${options.videoFps},scale=${options.outputWidth}:${options.outputHeight}:flags=lanczos`,
    );

    if (crfMode) {
      args.push(
        '-b:v', '0',
        '-crf', String(videoCrf),
      );
    } else {
      args.push('-b:v', `${options.videoBitrateKbps}k`);
    }

    args.push(outputPath);
  } else if (targetFormat === 'gif') {
    args.push(
      '-vf', `fps=${Math.min(options.videoFps, 15)},scale=${options.outputWidth}:${options.outputHeight}:flags=lanczos`,
      outputPath,
    );
  } else {
    throw new Error(`Unsupported video transcode target: ${targetFormat}`);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      }
    });
  });

  return outputPath;
}

async function syncMediaToTimeline(page, timeMs) {
  const targetSeconds = Math.max(0, timeMs / 1000);
  await page.evaluate(async ({ nextSeconds }) => {
    const videos = Array.from(document.querySelectorAll('video'));
    await Promise.allSettled(videos.map(async (video) => {
      try {
        video.pause();
        video.muted = true;

        const hasFiniteDuration = Number.isFinite(video.duration) && video.duration > 0;
        if (!hasFiniteDuration) return;

        const maxTime = Math.max(0, video.duration - (1 / 60));
        const clampedSeconds = Math.min(nextSeconds, maxTime);
        if (Math.abs(video.currentTime - clampedSeconds) < 0.03) return;

        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            video.removeEventListener('seeked', finish);
            video.removeEventListener('timeupdate', finish);
            video.removeEventListener('loadeddata', finish);
            video.removeEventListener('error', finish);
            resolve();
          };

          video.addEventListener('seeked', finish, { once: true });
          video.addEventListener('timeupdate', finish, { once: true });
          video.addEventListener('loadeddata', finish, { once: true });
          video.addEventListener('error', finish, { once: true });
          window.setTimeout(finish, 600);

          try {
            video.currentTime = clampedSeconds;
          } catch {
            finish();
          }
        });
      } catch {
        // Ignore media elements that cannot be controlled cross-origin.
      }
    }));
  }, { nextSeconds: targetSeconds });
}

async function renderScrollingVideo(page, options, tmpDir) {
  const framesDir = path.join(tmpDir, 'frames');
  const frameCount = Math.max(2, Math.round((options.totalDurationMs / 1000) * options.videoFps));
  const easingFn = getEasingFunction(options.scrollEasing);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'auto' }));
  await page.waitForTimeout(120);

  const { maxScroll } = await getScrollMetrics(page);
  const segments = buildScrollTimeline(Math.max(0, maxScroll), options);

  await mkdir(framesDir, { recursive: true });

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const timeMs = Math.min(options.totalDurationMs, Math.round((frameIndex / options.videoFps) * 1000));
    const scrollY = Math.round(positionForTimestamp(segments, timeMs, easingFn));
    await page.evaluate((nextY) => window.scrollTo({ top: nextY, behavior: 'auto' }), scrollY);
    await syncMediaToTimeline(page, timeMs);
    await page.waitForTimeout(frameIndex === 0 ? 140 : 8);

    await page.screenshot({
      path: path.join(framesDir, `frame-${String(frameIndex).padStart(6, '0')}.png`),
      type: 'png',
      animations: 'disabled',
    });
  }

  return encodeFrames(
    path.join(framesDir, 'frame-%06d.png'),
    options.format,
    tmpDir,
    options,
  );
}

async function capture(query) {
  const options = buildOptions(query);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'scrollshot-'));
  const browser = await launchBrowser();

  try {
    const contextOptions = {
      viewport: { width: options.viewportWidth, height: options.viewportHeight },
      deviceScaleFactor: options.deviceScaleFactor,
      ignoreHTTPSErrors: options.ignoreHostErrors,
    };

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(options.navigationTimeoutMs);

    await page.goto(options.targetUrl, { waitUntil: options.waitUntil, timeout: options.navigationTimeoutMs });
    await waitForRequestedStates(page, options);

    if (options.delayMs > 0) {
      await page.waitForTimeout(options.delayMs);
    }

    await bestEffortNetworkIdle(page);

    if (options.preloadLazyContent && !options.scrollingRequested) {
      await preloadLazyContent(page);
    }

    if (!options.scrollingRequested) {
      const buffer = await renderScreenshot(page, options);
      await context.close();
      return {
        buffer,
        mimeType: IMAGE_MIME[options.format] || 'application/octet-stream',
        fileName: `${options.outputName}.${options.format}`,
        cleanup: async () => {
          await browser.close();
          await rm(tmpDir, { recursive: true, force: true });
        },
      };
    }

    const outputPath = await renderScrollingVideo(page, options, tmpDir);
    await context.close();

    const buffer = await readFile(outputPath);
    return {
      buffer,
      mimeType: VIDEO_MIME[options.format] || 'application/octet-stream',
      fileName: `${options.outputName}.${options.format}`,
      cleanup: async () => {
        await browser.close();
        await rm(tmpDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser.close().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

app.get('/health', async () => ({ ok: true }));

app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/health')) return;

  if (API_KEYS.size > 0) {
    const suppliedKey = readApiKey(request);
    if (!API_KEYS.has(suppliedKey)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return reply;
    }
  }

  enforceRateLimit(request);
});

app.get('/take', async (request, reply) => {
  const result = await capture(request.query);
  try {
    reply.header('content-type', result.mimeType);
    reply.header('content-disposition', `inline; filename="${result.fileName}"`);
    return reply.send(result.buffer);
  } finally {
    await result.cleanup();
  }
});

app.get('/download', async (request, reply) => app.inject({
  method: 'GET',
  url: '/take',
  query: request.query,
}).then((response) => {
  reply.code(response.statusCode);
  for (const [name, value] of Object.entries(response.headers)) {
    reply.header(name, value);
  }
  return reply.send(response.rawPayload);
}));

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, 'capture failed');
  if (error.statusCode === 429 && error.retryAfterSeconds) {
    reply.header('retry-after', String(error.retryAfterSeconds));
  }
  reply.status(error.statusCode || 400).send({
    error: error.message,
  });
});

const bootstrap = async () => {
  if (CHROME_BIN) {
    await access(CHROME_BIN);
  }
  await app.listen({ port: PORT, host: '0.0.0.0' });
};

bootstrap().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
