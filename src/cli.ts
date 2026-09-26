#!/usr/bin/env node
/**
 * compresso <file...> [--out <dir>] [--suffix -min] [--json]
 * Reads the API key from COMPRESSO_API_KEY.
 */
import { basename, extname, join } from "node:path"
import { Compresso, CompressoError } from "./index.js"

interface Args {
  files: string[]
  out?: string
  suffix: string
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { files: [], suffix: "-min", json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--out" || arg === "-o") args.out = argv[++i]
    else if (arg === "--suffix") args.suffix = argv[++i] ?? "-min"
    else if (arg === "--json") args.json = true
    else if (arg === "--help" || arg === "-h") args.files = []
    else args.files.push(arg)
  }
  return args
}

function outputPath(input: string, args: Args): string {
  const ext = extname(input)
  const name = `${basename(input, ext)}${args.suffix}${ext}`
  return args.out ? join(args.out, name) : join(input, "..", name)
}

const HELP = `compresso — compress images through the Compresso API

  compresso photo.png                 write photo-min.png next to it
  compresso *.jpg --out optimized     write into a directory
  compresso photo.png --json          machine-readable output

Options:
  -o, --out <dir>   output directory (created beforehand by you)
      --suffix <s>  filename suffix, default "-min"
      --json        print one JSON object per file
  -h, --help        this message

Set COMPRESSO_API_KEY first. Keys: https://compresso.space/dashboard
`

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.files.length === 0) {
    process.stdout.write(HELP)
    return 0
  }

  let client: Compresso
  try {
    client = new Compresso()
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }

  let failed = 0
  for (const file of args.files) {
    const target = outputPath(file, args)
    try {
      const result = await client.compressFile(file, target)
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            file,
            output: target,
            originalSize: result.originalSize,
            compressedSize: result.compressedSize,
            savedPercent: result.savedPercent,
            usage: result.usage,
          })}\n`
        )
      } else {
        const saved = result.savedPercent > 0 ? `-${result.savedPercent}%` : "already optimal"
        process.stdout.write(`${file} → ${target}  ${saved}\n`)
      }
    } catch (error) {
      failed += 1
      const detail =
        error instanceof CompressoError
          ? `${error.code}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`
          : String(error)
      process.stderr.write(`${file}: ${detail}\n`)
    }
  }
  return failed > 0 ? 1 : 0
}

process.exitCode = await main()
