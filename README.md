# compresso-api

Node.js client for the [Compresso](https://compresso.space) image compression API. One request returns the compressed image: no job ids, no polling, no temporary URLs.

Compresso compresses PNG, JPEG and WebP and checks every result against the original pixel by pixel, so files get smaller without a visible quality loss. The free tier is **100 images per day** per account, no card required.

```bash
npm install compresso-api
```

## Quickstart

```js
import { Compresso } from "compresso-api"

const client = new Compresso() // reads COMPRESSO_API_KEY

const result = await client.compressFile("photo.png", "photo-min.png")
console.log(`${result.originalSize} → ${result.compressedSize} bytes (-${result.savedPercent}%)`)
console.log(`${result.usage?.count} of ${result.usage?.limit} images used today`)
```

Get a key at [compresso.space/dashboard](https://compresso.space/dashboard) and export it:

```bash
export COMPRESSO_API_KEY="csk_..."
```

## Command line

The package ships a small CLI:

```bash
npx compresso-api photo.png                  # writes photo-min.png
npx compresso-api *.jpg --out optimized      # writes into a directory
npx compresso-api photo.png --json           # one JSON object per file
```

## API

### `new Compresso(options?)`

| Option | Default | Meaning |
|---|---|---|
| `apiKey` | `process.env.COMPRESSO_API_KEY` | API key |
| `baseUrl` | `https://api.compresso.space/v1` | API root |
| `maxRetries` | `2` | Retries for errors the API marks retryable |
| `maxRetryDelayMs` | `60000` | Cap on a single `Retry-After` wait |
| `timeoutMs` | `120000` | Per-request timeout |
| `fetch` | global `fetch` | Injectable for tests or proxies |

### `client.compress(bytes)`

Takes a `Uint8Array` or `ArrayBuffer`, resolves with:

```ts
{
  data: Uint8Array        // the compressed image
  contentType: string     // image/png, image/jpeg, image/webp
  originalSize: number
  compressedSize: number
  savedBytes: number
  savedPercent: number
  usage?: { count: number; limit: number; reset: string }
  requestId?: string
}
```

### `client.compressFile(inputPath, outputPath?)`

Reads the file, compresses it, writes `outputPath` when given, and resolves with the same result object.

### `client.usage()`

```ts
{ plan: "free", compressionCount: 3, compressionLimit: 100, compressionReset: "2026-09-27T00:00:00Z", key: "csk_…a1b2" }
```

## Errors

Every failure is a `CompressoError` with a machine-readable `code`, the HTTP `status`, the API's `message`, and `requestId`. Errors that are worth retrying carry `retryAfter` (seconds) and `error.retryable === true`; the client already retries those `maxRetries` times.

```js
import { CompressoError } from "compresso-api"

try {
  await client.compressFile("huge.png", "huge-min.png")
} catch (error) {
  if (error instanceof CompressoError && error.code === "file_too_large") {
    // resize before sending: the API takes up to 16 MB and 16 megapixels
  } else {
    throw error
  }
}
```

Common codes: `unauthorized`, `input_missing`, `invalid_image`, `unsupported_format`, `file_too_large`, `image_too_large`, `daily_limit_exceeded`, `rate_limited`, `server_busy`, `compress_failed`. The full table is in the [API docs](https://compresso.space/developers#errors).

## Limits

- 16 MB and 16 megapixels per image
- 100 images per day per account on the free tier (resets at 00:00 UTC)
- one request in flight plus one waiting per account
- images are processed in memory and never stored or logged

## Requirements

Node.js 18 or newer. No runtime dependencies.

## License

MIT
