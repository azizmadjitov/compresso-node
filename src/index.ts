/**
 * Node client for the Compresso image compression API.
 * Docs: https://compresso.space/developers
 */

export const DEFAULT_BASE_URL = "https://api.compresso.space/v1"

export interface Usage {
  /** Images compressed today (UTC). */
  count: number
  /** Daily allowance for this account. */
  limit: number
  /** ISO timestamp when the counter resets. */
  reset: string
}

export interface CompressResult {
  /** The compressed image itself. */
  data: Uint8Array
  contentType: string
  originalSize: number
  compressedSize: number
  /** Bytes saved; 0 when the API returned the original unchanged. */
  savedBytes: number
  /** Saving as a percentage of the original, rounded to one decimal. */
  savedPercent: number
  usage?: Usage
  requestId?: string
}

export interface AccountUsage {
  plan: string
  compressionCount: number
  compressionLimit: number
  compressionReset: string
  key: string
}

export interface CompressoOptions {
  /** API key from https://compresso.space/dashboard. Defaults to COMPRESSO_API_KEY. */
  apiKey?: string
  baseUrl?: string
  /** Retries for errors the API marks retryable (Retry-After). Default 2. */
  maxRetries?: number
  /** Cap on a single Retry-After wait, in milliseconds. Default 60000. */
  maxRetryDelayMs?: number
  /** Per-request timeout in milliseconds. Default 120000. */
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

/** An error returned by the API, or a transport failure while talking to it. */
export class CompressoError extends Error {
  /** Machine-readable code, e.g. file_too_large, daily_limit_exceeded, server_busy. */
  readonly code: string
  readonly status: number
  readonly requestId?: string
  /** Seconds to wait before retrying; absent when retrying cannot help. */
  readonly retryAfter?: number
  readonly usage?: Usage

  constructor(
    code: string,
    message: string,
    init: { status?: number; requestId?: string; retryAfter?: number; usage?: Usage } = {}
  ) {
    super(message)
    this.name = "CompressoError"
    this.code = code
    this.status = init.status ?? 0
    this.requestId = init.requestId
    this.retryAfter = init.retryAfter
    this.usage = init.usage
  }

  /** True when the API said a later attempt may succeed. */
  get retryable(): boolean {
    return this.retryAfter !== undefined
  }
}

function readUsage(headers: Headers): Usage | undefined {
  const count = Number(headers.get("Compression-Count"))
  const limit = Number(headers.get("Compression-Limit"))
  const reset = headers.get("Compression-Reset")
  if (!Number.isFinite(count) || !Number.isFinite(limit) || !reset) return undefined
  return { count, limit, reset }
}

function readRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("Retry-After")
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toBody(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input)
}

export class Compresso {
  readonly baseUrl: string
  readonly #apiKey: string
  readonly #maxRetries: number
  readonly #maxRetryDelayMs: number
  readonly #timeoutMs: number
  readonly #fetch: typeof globalThis.fetch

  constructor(options: CompressoOptions = {}) {
    const apiKey = options.apiKey ?? process.env.COMPRESSO_API_KEY
    if (!apiKey) {
      throw new CompressoError(
        "missing_api_key",
        "No API key. Pass { apiKey } or set COMPRESSO_API_KEY. Keys: https://compresso.space/dashboard"
      )
    }
    this.#apiKey = apiKey
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.#maxRetries = options.maxRetries ?? 2
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000
    this.#timeoutMs = options.timeoutMs ?? 120_000
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  /** Compress raw image bytes. Resolves with the compressed image. */
  async compress(input: Uint8Array | ArrayBuffer): Promise<CompressResult> {
    const body = toBody(input)
    if (body.byteLength === 0) {
      throw new CompressoError("input_missing", "The image is empty.")
    }
    const res = await this.#send("/compress", body)
    const buffer = new Uint8Array(await res.arrayBuffer())
    const originalSize = Number(res.headers.get("Original-Size")) || body.byteLength
    const compressedSize = Number(res.headers.get("Compressed-Size")) || buffer.byteLength
    const savedBytes = Math.max(0, originalSize - compressedSize)
    return {
      data: buffer,
      contentType: res.headers.get("Content-Type") ?? "application/octet-stream",
      originalSize,
      compressedSize,
      savedBytes,
      savedPercent: originalSize > 0 ? Math.round((savedBytes / originalSize) * 1000) / 10 : 0,
      usage: readUsage(res.headers),
      requestId: res.headers.get("Request-Id") ?? undefined,
    }
  }

  /**
   * Compress a file on disk. Writes the result to `outputPath` when given,
   * and always resolves with the compressed bytes.
   */
  async compressFile(inputPath: string, outputPath?: string): Promise<CompressResult> {
    const { readFile, writeFile } = await import("node:fs/promises")
    const result = await this.compress(await readFile(inputPath))
    if (outputPath) await writeFile(outputPath, result.data)
    return result
  }

  /** Today's usage for the account behind the key. */
  async usage(): Promise<AccountUsage> {
    const res = await this.#send("/usage")
    const body = (await res.json()) as Record<string, unknown>
    return {
      plan: String(body.plan ?? "free"),
      compressionCount: Number(body.compression_count ?? 0),
      compressionLimit: Number(body.compression_limit ?? 0),
      compressionReset: String(body.compression_reset ?? ""),
      key: String(body.key ?? ""),
    }
  }

  async #send(path: string, body?: Uint8Array): Promise<Response> {
    let attempt = 0
    for (;;) {
      let res: Response
      try {
        res = await this.#fetch(`${this.baseUrl}${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            ...(body ? { "Content-Type": "application/octet-stream" } : {}),
          },
          body: body as BodyInit | undefined,
          signal: AbortSignal.timeout(this.#timeoutMs),
        })
      } catch (cause) {
        if (attempt >= this.#maxRetries) {
          throw new CompressoError("network_error", `Could not reach ${this.baseUrl}: ${cause}`)
        }
        attempt += 1
        await sleep(1000 * attempt)
        continue
      }

      if (res.ok) return res

      const error = await this.#toError(res)
      if (error.retryAfter !== undefined && attempt < this.#maxRetries) {
        attempt += 1
        await sleep(Math.min(error.retryAfter * 1000, this.#maxRetryDelayMs))
        continue
      }
      throw error
    }
  }

  async #toError(res: Response): Promise<CompressoError> {
    let code = `http_${res.status}`
    let message = `Request failed with status ${res.status}.`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      if (body.error) code = body.error
      if (body.message) message = body.message
    } catch {
      // A non-JSON body (a proxy error page, say) leaves the defaults in place.
    }
    return new CompressoError(code, message, {
      status: res.status,
      requestId: res.headers.get("Request-Id") ?? undefined,
      retryAfter: readRetryAfter(res.headers),
      usage: readUsage(res.headers),
    })
  }
}

export default Compresso
