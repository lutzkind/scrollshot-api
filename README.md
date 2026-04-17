# ScrollShot API

A small self-hosted replacement for ScreenshotOne built for n8n workflows.

## What it does

- Full-page website screenshots in `png`, `jpeg`, or `webp`
- Smooth auto-scrolling recordings in `webm`, `mp4`, or `gif`
- ScreenshotOne-style query parameters so an existing HTTP Request node needs minimal changes

## Endpoint

- `GET /take`
- `GET /health`

## Access control

- Set `API_KEY` or `API_KEYS` to require authentication on `/take` and `/download`
- Send the key with `x-api-key: ...`, `Authorization: Bearer ...`, or `api_key=...`
- Default rate limit is `30` requests per `60` seconds per client IP
- Tune with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`

## Supported query params

- `url` required
- `format=png|jpeg|webp|webm|mp4|gif`
- `scenario=scroll` for ScreenshotOne-style animated capture
- `duration` total animation time in seconds, default `10`
- `viewport_width` default `1280`
- `viewport_height` default `720`
- `device_scale_factor` default `1`
- `full_page=true|false` default `true`
- `full_page_scroll=true|false` to force scrolling video mode
- `delay` wait in milliseconds after navigation
- `wait_until=load|domcontentloaded|networkidle|commit` and repeated `wait_until` values are accepted
- `scroll_delay` pause between scroll moves, default `500`
- `scroll_duration` per-step motion duration, default `1500`
- `scroll_by` step size in pixels, default roughly one viewport
- `scroll_complete=true|false`
- `scroll_start_delay` default `0`
- `scroll_start_immediately=true|false`
- `scroll_back=true|false`
- `scroll_back_after_duration`
- `scroll_stop_after_duration`
- `scroll_easing`
- `scroll_jitter_px`
- `hold_duration`
- `preload_lazy_content=true|false`
- `video_bitrate_kbps` default `4000`
- `video_preset` default `medium`
- `video_crf` optional if you want CRF mode instead of target bitrate
- `ignore_host_errors=true|false`

## Local run

```bash
cd /root/scrollshot-api
npm install
npm start
```

Server listens on `http://127.0.0.1:3199`.

## Docker run

```bash
docker build -t scrollshot-api /root/scrollshot-api
docker run -d --name scrollshot-api --restart unless-stopped -p 3199:3199 scrollshot-api
```

## n8n migration

If your current node points at ScreenshotOne, switch the host to this service and keep the query parameters close to what you already use.

Example still image:

```text
http://127.0.0.1:3199/take?url=https%3A%2F%2Fexample.com&format=png&full_page=true&viewport_width=1280&viewport_height=2200&api_key=YOUR_KEY
```

Example ScreenshotOne-style scrolling video for Cloudinary upload:

```text
http://127.0.0.1:3199/take?url=https%3A%2F%2Fexample.com&scenario=scroll&duration=10&scroll_complete=false&scroll_start_delay=2000&scroll_start_immediately=false&wait_until=domcontentloaded&wait_until=networkidle2&ignore_host_errors=true&api_key=YOUR_KEY
```

In n8n:

1. Use an `HTTP Request` node.
2. Set `Response Format` to `File`.
3. Add your key as `x-api-key` or `api_key`.
4. Pass the target URL in the query string.
5. Send the returned binary directly to your Cloudinary upload node.
