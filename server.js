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

function normalizeFormat(value) {
  const format = String(value || 'png').trim().toLowerCase();
  if (format === 'jpg') return 'jpeg';
  return format;
}

function normalizeScrollPattern(value) {
  const candidate = String(value || 'preset_current').trim().toLowerCase();

  if (['current', 'preset_current', 'smooth', 'default'].includes(candidate)) {
    return 'preset_current';
  }

  if (['random', 'preset_random', 'human', 'humanized'].includes(candidate)) {
    return 'preset_random';
  }

  if (candidate === 'manual') {
    return 'manual';
  }

  return 'preset_current';
}

function seedFromValue(value) {
  if (value === undefined || value === null || value === '') {
    return Math.floor(Math.random() * 0x7fffffff);
  }

  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isNaN(numeric)) {
    return Math.abs(numeric) || 1;
  }

  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) || 1;
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

function pickWaitUntil(value) {
  const candidate = String(value || 'networkidle').trim().toLowerCase();
  if (['load', 'domcontentloaded', 'networkidle', 'commit'].includes(candidate)) {
    return candidate;
  }
  return 'networkidle';
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
  const format = normalizeFormat(query.format);
  const videoRequested = ['webm', 'mp4', 'gif'].includes(format);
  const scrollingRequested = toBoolean(query.full_page_scroll, false)
    || toBoolean(query.animate, false)
    || toBoolean(query.scrolling_screenshot, false)
    || videoRequested;

  return {
    targetUrl: assertUrl(query.url),
    format,
    width: toInt(query.viewport_width ?? query.width, 1280, { min: 320, max: 3840 }),
    height: toInt(query.viewport_height ?? query.height, 720, { min: 320, max: 3840 }),
    deviceScaleFactor: Number.parseFloat(String(query.device_scale_factor ?? query.scale_factor ?? 1)) || 1,
    fullPage: toBoolean(query.full_page, true),
    preloadLazyContent: toBoolean(query.preload_lazy_content, true),
    waitUntil: pickWaitUntil(query.wait_until),
    navigationTimeoutMs: toInt(query.navigation_timeout, 45000, { min: 5000, max: 180000 }),
    delayMs: toInt(query.delay, 1500, { min: 0, max: 120000 }),
    imageQuality: toInt(query.image_quality ?? query.quality, 90, { min: 1, max: 100 }),
    scrollingRequested,
    scrollPattern: normalizeScrollPattern(query.scroll_pattern ?? query.scroll_profile),
    scrollDurationMs: toInt(query.scroll_duration ?? query.animation_duration, 9000, { min: 1000, max: 120000 }),
    holdDurationMs: toInt(query.hold_duration, 1200, { min: 0, max: 30000 }),
    scrollBack: toBoolean(query.scroll_back, false),
    scrollStartImmediately: toBoolean(query.scroll_start_immediately, false),
    scrollStartDelayMs: toInt(query.scroll_start_delay, 2000, { min: 0, max: 30000 }),
    scrollSteps: toInt(query.scroll_steps, 4, { min: 1, max: 24 }),
    scrollComplete: toBoolean(query.scroll_complete, false),
    scrollSeed: seedFromValue(query.scroll_seed),
    randomPauseJitterMs: toInt(query.scroll_pause_jitter, 450, { min: 0, max: 5000 }),
    randomBacktrackPx: toInt(query.scroll_backtrack_px, 90, { min: 0, max: 600 }),
    randomBurstCount: toInt(query.scroll_burst_count, 0, { min: 0, max: 30 }),
    videoFps: toInt(query.video_fps ?? query.fps, format === 'gif' ? 12 : 15, { min: 1, max: 60 }),
    videoBitrateKbps: toInt(query.video_bitrate_kbps ?? query.bitrate_kbps, 1200, { min: 100, max: 20000 }),
    videoPreset: String(query.video_preset || 'medium').trim().toLowerCase(),
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

async function recordScrollingVideo(page, options) {
  if (options.scrollPattern === 'manual' && !options.scrollStartImmediately && options.scrollStartDelayMs > 0) {
    await page.waitForTimeout(options.scrollStartDelayMs);
  }

  await page.evaluate(async ({
    durationMs,
    pattern,
    scrollBack,
    scrollSteps,
    scrollComplete,
    scrollSeed,
    randomPauseJitterMs,
    randomBacktrackPx,
    randomBurstCount,
  }) => {
    const maxScroll = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
    ) - window.innerHeight;

    if (maxScroll <= 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(durationMs, 1000)));
      return { maxScroll: 0 };
    }

    const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const minTargetPadding = Math.min(Math.max(window.innerHeight * 0.22, 96), 240);
    const finalTarget = scrollComplete ? maxScroll : Math.max(0, maxScroll - minTargetPadding);

    const animateTo = (from, to, ms) => new Promise((resolve) => {
      if (ms <= 0 || Math.abs(to - from) < 1) {
        window.scrollTo(0, to);
        resolve();
        return;
      }

      const start = performance.now();
      const tick = (now) => {
        const progress = Math.min((now - start) / ms, 1);
        const target = from + ((to - from) * easeInOut(progress));
        window.scrollTo(0, target);
        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });

    const createRng = (seed) => {
      let state = seed >>> 0;
      return () => {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    const runCurrentPattern = async () => {
      await animateTo(0, finalTarget, durationMs);
    };

    const runManualPattern = async () => {
      const steps = Math.max(1, scrollSteps);
      const pauseMs = steps > 1 ? Math.min(180, Math.round(durationMs * 0.03)) : 0;
      const animationBudget = Math.max(250, durationMs - (pauseMs * Math.max(0, steps - 1)));
      const stepDuration = Math.max(200, Math.round(animationBudget / steps));
      let current = 0;

      for (let index = 1; index <= steps; index += 1) {
        const target = finalTarget * (index / steps);
        await animateTo(current, target, stepDuration);
        current = target;

        if (index < steps && pauseMs > 0) {
          await sleep(pauseMs);
        }
      }
    };

    const runRandomPattern = async () => {
      const rng = createRng(scrollSeed);
      const bursts = randomBurstCount > 0
        ? randomBurstCount
        : Math.min(12, Math.max(5, Math.round(finalTarget / Math.max(window.innerHeight * 0.55, 260))));
      const pauseDurations = Array.from({ length: Math.max(0, bursts - 1) }, () =>
        Math.round(80 + (rng() * randomPauseJitterMs)));
      const backtrackDurations = Array.from({ length: bursts }, () =>
        (rng() < 0.35 ? Math.round(110 + (rng() * 180)) : 0));
      const totalPauseMs = pauseDurations.reduce((sum, value) => sum + value, 0);
      const totalBacktrackMs = backtrackDurations.reduce((sum, value) => sum + value, 0);
      const forwardBudgetMs = Math.max(800, durationMs - totalPauseMs - totalBacktrackMs);
      const weights = Array.from({ length: bursts }, () => 0.75 + (rng() * 1.6));
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      let current = 0;
      let cumulativeWeight = 0;

      for (let index = 0; index < bursts; index += 1) {
        cumulativeWeight += weights[index];
        const isLast = index === bursts - 1;
        const target = isLast ? finalTarget : Math.min(
          finalTarget,
          finalTarget * (cumulativeWeight / totalWeight),
        );
        const moveDuration = Math.max(180, Math.round(forwardBudgetMs * (weights[index] / totalWeight)));

        if (index > 0 && backtrackDurations[index] > 0) {
          const backtrackDistance = Math.min(
            current * 0.45,
            12 + (rng() * randomBacktrackPx),
          );

          if (backtrackDistance > 8) {
            const fallbackTarget = Math.max(0, current - backtrackDistance);
            await animateTo(current, fallbackTarget, backtrackDurations[index]);
            current = fallbackTarget;
          }
        }

        await animateTo(current, target, moveDuration);
        current = target;

        if (!isLast && pauseDurations[index] > 0) {
          await sleep(pauseDurations[index]);
        }
      }
    };

    if (pattern === 'manual') {
      await runManualPattern();
    } else if (pattern === 'preset_random') {
      await runRandomPattern();
    } else {
      await runCurrentPattern();
    }

    if (scrollBack) {
      window.scrollTo(0, 0);
    }

    return { maxScroll };
  }, {
    durationMs: options.scrollDurationMs,
    pattern: options.scrollPattern,
    scrollBack: options.scrollBack,
    scrollSteps: options.scrollSteps,
    scrollComplete: options.scrollComplete,
    scrollSeed: options.scrollSeed,
    randomPauseJitterMs: options.randomPauseJitterMs,
    randomBacktrackPx: options.randomBacktrackPx,
    randomBurstCount: options.randomBurstCount,
  });

  if (options.holdDurationMs > 0) {
    await page.waitForTimeout(options.holdDurationMs);
  }
}

async function transcode(inputPath, targetFormat, tmpDir, options) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available for transcoding');
  }

  const outputPath = path.join(tmpDir, `output.${targetFormat}`);
  const args = ['-y', '-i', inputPath];
  const safePreset = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].includes(options.videoPreset)
    ? options.videoPreset
    : 'medium';
  const targetBitrate = `${options.videoBitrateKbps}k`;
  const bufferBitrate = `${Math.max(options.videoBitrateKbps * 2, options.videoBitrateKbps + 500)}k`;

  if (targetFormat === 'mp4') {
    args.push(
      '-an',
      '-c:v', 'libx264',
      '-preset', safePreset,
      '-b:v', targetBitrate,
      '-maxrate', targetBitrate,
      '-bufsize', bufferBitrate,
      '-movflags', 'faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', `fps=${options.videoFps}`,
      outputPath,
    );
  } else if (targetFormat === 'gif') {
    args.push(
      '-vf', `fps=${options.videoFps},scale=${options.width}:-1:flags=lanczos`,
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

async function capture(query) {
  const options = buildOptions(query);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'scrollshot-'));
  const browser = await launchBrowser();

  try {
    const contextOptions = {
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: options.deviceScaleFactor,
      recordVideo: options.scrollingRequested ? {
        dir: tmpDir,
        size: { width: options.width, height: options.height },
      } : undefined,
    };

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(options.navigationTimeoutMs);

    await page.goto(options.targetUrl, { waitUntil: options.waitUntil, timeout: options.navigationTimeoutMs });
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
    let outputPath = recordedPath;
    let extension = 'webm';
    let mimeType = VIDEO_MIME.webm;

    if (options.format === 'mp4' || options.format === 'gif') {
      outputPath = await transcode(recordedPath, options.format, tmpDir, options);
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
