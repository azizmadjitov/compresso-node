import assert from "node:assert/strict"
import { test } from "node:test"
import { Compresso, CompressoError } from "../src/index.ts"

const KEY = "csk_test"

function binaryResponse(bytes: Uint8Array, headers: Record<string, string>): Response {
  return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png", ...headers } })
}

function errorResponse(
  status: number,
  body: { error: string; message: string },
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

test("compress returns the image, sizes and usage", async () => {
  const client = new Compresso({
    apiKey: KEY,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.compresso.space/v1/compress")
      assert.equal(init?.method, "POST")
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${KEY}`)
      return binaryResponse(new Uint8Array([1, 2, 3]), {
        "Original-Size": "1000",
        "Compressed-Size": "250",
        "Compression-Count": "7",
        "Compression-Limit": "100",
        "Compression-Reset": "2026-09-27T00:00:00Z",
        "Request-Id": "abc",
      })
    },
  })

  const result = await client.compress(new Uint8Array([9, 9, 9, 9]))
  assert.deepEqual([...result.data], [1, 2, 3])
  assert.equal(result.originalSize, 1000)
  assert.equal(result.compressedSize, 250)
  assert.equal(result.savedBytes, 750)
  assert.equal(result.savedPercent, 75)
  assert.deepEqual(result.usage, { count: 7, limit: 100, reset: "2026-09-27T00:00:00Z" })
  assert.equal(result.requestId, "abc")
})

test("an API error becomes a CompressoError with its code", async () => {
  const client = new Compresso({
    apiKey: KEY,
    fetch: async () =>
      errorResponse(413, { error: "file_too_large", message: "The image is over 16 MB." }),
  })

  await assert.rejects(
    () => client.compress(new Uint8Array([1])),
    (error: unknown) => {
      assert.ok(error instanceof CompressoError)
      assert.equal(error.code, "file_too_large")
      assert.equal(error.status, 413)
      assert.equal(error.retryable, false)
      return true
    }
  )
})

test("server_busy is retried once Retry-After has passed", async () => {
  let calls = 0
  const client = new Compresso({
    apiKey: KEY,
    maxRetryDelayMs: 5,
    fetch: async () => {
      calls += 1
      if (calls === 1) {
        return errorResponse(
          503,
          { error: "server_busy", message: "Too many requests in flight." },
          { "Retry-After": "1" }
        )
      }
      return binaryResponse(new Uint8Array([4]), { "Original-Size": "10", "Compressed-Size": "4" })
    },
  })

  const result = await client.compress(new Uint8Array([1]))
  assert.equal(calls, 2)
  assert.equal(result.compressedSize, 4)
})

test("the daily limit is not retried", async () => {
  let calls = 0
  const client = new Compresso({
    apiKey: KEY,
    fetch: async () => {
      calls += 1
      return errorResponse(429, {
        error: "daily_limit_exceeded",
        message: "100 images used today.",
      })
    },
  })

  await assert.rejects(() => client.compress(new Uint8Array([1])), /100 images used today/)
  assert.equal(calls, 1)
})

test("usage() maps the JSON payload", async () => {
  const client = new Compresso({
    apiKey: KEY,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.compresso.space/v1/usage")
      assert.equal(init?.method, "GET")
      return new Response(
        JSON.stringify({
          ok: true,
          plan: "free",
          compression_count: 3,
          compression_limit: 100,
          compression_reset: "2026-09-27T00:00:00Z",
          key: "csk_…a1b2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    },
  })

  const usage = await client.usage()
  assert.equal(usage.plan, "free")
  assert.equal(usage.compressionCount, 3)
  assert.equal(usage.compressionLimit, 100)
})

test("a missing key fails before any request", () => {
  const previous = process.env.COMPRESSO_API_KEY
  delete process.env.COMPRESSO_API_KEY
  try {
    assert.throws(() => new Compresso(), /No API key/)
  } finally {
    if (previous !== undefined) process.env.COMPRESSO_API_KEY = previous
  }
})

test("empty input is rejected locally", async () => {
  const client = new Compresso({
    apiKey: KEY,
    fetch: async () => {
      throw new Error("must not be called")
    },
  })
  await assert.rejects(() => client.compress(new Uint8Array()), /empty/)
})

test("the default fetch is called the way browsers require", async () => {
  // Browsers throw "Illegal invocation" when fetch runs with a foreign receiver,
  // for example as a method of the client object. Node does not care, so this
  // stand-in enforces the browser rule.
  const original = globalThis.fetch
  globalThis.fetch = function (this: unknown, ..._args: Parameters<typeof fetch>) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, plan: "free", compression_count: 1, compression_limit: 100 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  } as typeof fetch
  try {
    const usage = await new Compresso({ apiKey: KEY }).usage()
    assert.equal(usage.compressionCount, 1)
  } finally {
    globalThis.fetch = original
  }
})
