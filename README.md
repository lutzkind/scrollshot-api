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
- `viewport_width` default `1280`
- `viewport_height` default `720`
- `device_scale_factor` default `1`
- `full_page=true|false` default `true`
- `full_page_scroll=true|false` to force scrolling video mode
- `delay` wait in milliseconds after navigation
- `wait_until=load|domcontentloaded|networkidle|commit`
- `scroll_duration` default `9000`
- `hold_duration` default `1200`
- `scroll_back=true|false`
- `preload_lazy_content=true|false`

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

Example scrolling video for Cloudinary upload:

```text
http://127.0.0.1:3199/take?url=https%3A%2F%2Fexample.com&format=mp4&full_page_scroll=true&viewport_width=1280&viewport_height=720&scroll_duration=9000&api_key=YOUR_KEY
```

In n8n:

1. Use an `HTTP Request` node.
2. Set `Response Format` to `File`.
3. Add your key as `x-api-key` or `api_key`.
4. Pass the target URL in the query string.
5. Send the returned binary directly to your Cloudinary upload node.
