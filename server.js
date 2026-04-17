import Fastify from 'fastify';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  const preset = String(value || 'fast').trim().toLowerCase();
  if (['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].includes(preset)) {
    return preset;
  }
  return 'fast';
}

function normalizeEasing(value) {
  const easing = String(value || 'ease_in_out_quint').trim().toLowerCase();
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
    scrollStartDelayMs: toInt(query.scroll_start_delay, 0, { min: 0, max: 30000 }),
    scrollStartImmediately: toBoolean(query.scroll_start_immediately, true),
    scrollBack: toBoolean(query.scroll_back, scenario === 'scroll'),
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
    if (!options.scrollingRequested) {
      await bestEffortNetworkIdle(page);
    }
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

async function recordScrollingVideo(page, options) {
  const evaluationResult = await page.evaluate(async ({
    totalDurationMs,
    scrollDelayMs,
    scrollStepDurationMs,
    scrollByPx,
    scrollBack,
    scrollComplete,
    scrollStartDelayMs,
    scrollStartImmediately,
    scrollBackAfterDurationMs,
    scrollStopAfterDurationMs,
    scrollEasing,
    scrollJitterPx,
  }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rand = (min, max) => min + Math.random() * (max - min);
    const randInt = (min, max) => Math.round(rand(min, max));
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
    const easing = easingMap[scrollEasing] || easingMap.ease_in_out_quint;
    const maxScroll = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
    ) - window.innerHeight;

    const animateTo = async (destination, durationMs) => new Promise((resolve) => {
      const startY = window.scrollY;
      const delta = destination - startY;
      const startTime = performance.now();

      const tick = (now) => {
        const progress = Math.min((now - startTime) / durationMs, 1);
        const eased = easing(progress);
        window.scrollTo(0, startY + delta * eased);
        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };

      requestAnimationFrame(tick);
    });

    const startedAt = performance.now();
    const stopAt = startedAt + (scrollStopAfterDurationMs ?? totalDurationMs);
    let scrolledBack = false;

    if (!scrollStartImmediately && scrollStartDelayMs > 0) {
      await sleep(scrollStartDelayMs);
    }

    if (maxScroll <= 0) {
      const remaining = Math.max(0, stopAt - performance.now());
      if (remaining > 0) {
        await sleep(remaining);
      }
      return { maxScroll: 0, reachedBottom: true };
    }

    while (performance.now() < stopAt) {
      const elapsed = performance.now() - startedAt;
      const remaining = stopAt - performance.now();
      const currentY = window.scrollY;
      const atBottom = currentY >= maxScroll - 4;

      if (!scrolledBack && scrollBack && scrollBackAfterDurationMs !== null && elapsed >= scrollBackAfterDurationMs) {
        await animateTo(0, Math.max(700, Math.round(scrollStepDurationMs * 0.85)));
        scrolledBack = true;
        continue;
      }

      if (atBottom) {
        if (scrollComplete) {
          break;
        }

        if (!scrolledBack && scrollBack && scrollBackAfterDurationMs === null && elapsed >= totalDurationMs * 0.72) {
          await animateTo(0, Math.max(850, Math.round(scrollStepDurationMs * 0.95)));
          scrolledBack = true;
          continue;
        }

        await sleep(Math.min(remaining, 220));
        continue;
      }

      const plannedStep = scrollByPx + randInt(-scrollJitterPx, scrollJitterPx);
      const correctionAllowance = Math.min(currentY, randInt(10, Math.max(18, Math.round(scrollJitterPx * 0.9))));
      const nextY = Math.max(
        0,
        Math.min(maxScroll, currentY + plannedStep),
      );
      const stepDurationMs = Math.min(
        Math.max(220, scrollStepDurationMs + randInt(-220, 260)),
        Math.max(220, remaining - Math.min(scrollDelayMs, 180)),
      );

      await animateTo(nextY, stepDurationMs);

      if (Math.random() < 0.38 && correctionAllowance > 14 && performance.now() + 180 < stopAt) {
        const rewindTo = Math.max(0, window.scrollY - correctionAllowance);
        window.scrollTo(0, rewindTo);
        await sleep(randInt(80, 180));
        window.scrollTo(0, Math.min(maxScroll, rewindTo + correctionAllowance + randInt(8, 24)));
      }

      if (performance.now() >= stopAt) {
        break;
      }

      const pauseMs = Math.min(
        Math.max(0, scrollDelayMs + randInt(-120, 160)),
        Math.max(0, stopAt - performance.now()),
      );
      if (pauseMs > 0) {
        await sleep(pauseMs);
      }
    }

    return {
      maxScroll,
      reachedBottom: window.scrollY >= maxScroll - 4,
    };
  }, {
    totalDurationMs: options.totalDurationMs,
    scrollDelayMs: options.scrollDelayMs,
    scrollStepDurationMs: options.scrollStepDurationMs,
    scrollByPx: options.scrollByPx,
    scrollBack: options.scrollBack,
    scrollComplete: options.scrollComplete,
    scrollStartDelayMs: options.scrollStartDelayMs,
    scrollStartImmediately: options.scrollStartImmediately,
    scrollBackAfterDurationMs: options.scrollBackAfterDurationMs,
    scrollStopAfterDurationMs: options.scrollStopAfterDurationMs,
    scrollEasing: options.scrollEasing,
    scrollJitterPx: options.scrollJitterPx,
  });

  if (options.holdDurationMs > 0 && evaluationResult.reachedBottom) {
    await page.waitForTimeout(options.holdDurationMs);
  }
}

async function transcode(inputPath, targetFormat, tmpDir, options) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available for transcoding');
  }

  const outputPath = path.join(tmpDir, `output.${targetFormat}`);
  const args = ['-y'];

  if (options.trimStartSeconds && options.trimStartSeconds > 0) {
    args.push('-ss', String(options.trimStartSeconds));
  }

  args.push('-i', inputPath);

  if (options.trimDurationSeconds && options.trimDurationSeconds > 0) {
    args.push('-t', String(options.trimDurationSeconds));
  }

  if (targetFormat === 'mp4') {
    const crfMode = options.videoCrf !== undefined && options.videoCrf !== null && String(options.videoCrf) !== '';
    const videoCrf = crfMode
      ? toInt(options.videoCrf, 18, { min: 12, max: 35 })
      : null;
    args.push(
      '-an',
      '-c:v', 'libx264',
      '-preset', options.videoPreset,
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

async function probeDurationSeconds(inputPath) {
  if (!ffmpegPath) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-i', inputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', () => {
      const match = stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) {
        resolve(null);
        return;
      }

      const [, hh, mm, ss] = match;
      resolve((Number(hh) * 3600) + (Number(mm) * 60) + Number(ss));
    });
  });
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
      recordVideo: options.scrollingRequested ? {
        dir: tmpDir,
        size: { width: options.outputWidth, height: options.outputHeight },
      } : undefined,
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

    const video = page.video();
    await recordScrollingVideo(page, options);
    await context.close();

    const recordedPath = await video.path();
    const recordedDurationSeconds = await probeDurationSeconds(recordedPath);
    let outputPath = recordedPath;
    let extension = 'webm';
    let mimeType = VIDEO_MIME.webm;

    if (options.format === 'mp4' || options.format === 'gif') {
      const desiredDurationSeconds = options.totalDurationMs / 1000;
      const trimStartSeconds = recordedDurationSeconds && recordedDurationSeconds > desiredDurationSeconds
        ? Math.max(0, recordedDurationSeconds - desiredDurationSeconds)
        : 0;
      outputPath = await transcode(recordedPath, options.format, tmpDir, {
        ...options,
        trimStartSeconds,
        trimDurationSeconds: desiredDurationSeconds,
      });
      extension = options.format;
      mimeType = VIDEO_MIME[options.format];
    }

    const buffer = await readFile(outputPath);
    return {
      buffer,
      mimeType,
      fileName: `${options.outputName}.${extension}`,
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
