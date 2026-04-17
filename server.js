import Fastify from 'fastify';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT || 3199);
const PLAYWRIGHT_CHANNEL = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
const CHROME_BIN = process.env.CHROME_BIN || '';

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
    scrollDurationMs: toInt(query.scroll_duration ?? query.animation_duration, 9000, { min: 1000, max: 120000 }),
    holdDurationMs: toInt(query.hold_duration, 1200, { min: 0, max: 30000 }),
    scrollBack: toBoolean(query.scroll_back, false),
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
  await page.evaluate(async ({ durationMs, scrollBack }) => {
    const maxScroll = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
    ) - window.innerHeight;

    if (maxScroll <= 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(durationMs, 1000)));
      return { maxScroll: 0 };
    }

    const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

    await new Promise((resolve) => {
      const start = performance.now();
      const tick = (now) => {
        const progress = Math.min((now - start) / durationMs, 1);
        const target = maxScroll * easeInOut(progress);
        window.scrollTo(0, target);
        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });

    if (scrollBack) {
      window.scrollTo(0, 0);
    }

    return { maxScroll };
  }, {
    durationMs: options.scrollDurationMs,
    scrollBack: options.scrollBack,
  });

  if (options.holdDurationMs > 0) {
    await page.waitForTimeout(options.holdDurationMs);
  }
}

async function transcode(inputPath, targetFormat, tmpDir) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is not available for transcoding');
  }

  const outputPath = path.join(tmpDir, `output.${targetFormat}`);
  const args = ['-y', '-i', inputPath];

  if (targetFormat === 'mp4') {
    args.push(
      '-an',
      '-movflags', 'faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', 'fps=30',
      outputPath,
    );
  } else if (targetFormat === 'gif') {
    args.push(
      '-vf', 'fps=12,scale=1280:-1:flags=lanczos',
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
      outputPath = await transcode(recordedPath, options.format, tmpDir);
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
  reply.status(400).send({
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
