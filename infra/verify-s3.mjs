// End-to-end check of the local s3proxy the way the app will use it:
// SDK round trip, presigned PUT/GET/HEAD from "the browser" (fetch with an
// Origin header), CORS preflight, and a few negative cases.
//
//   cd infra && pnpm install --ignore-workspace   # once
//   nix shell nixpkgs#nodejs_22 -c node infra/verify-s3.mjs
//
// Reads ../.env (repo root) unless the S3_* vars are already set.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const here = dirname(fileURLToPath(import.meta.url))
const envFile = process.env.ENV_FILE ?? join(here, '..', '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile) // never overrides existing env

const cfg = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:8080',
  region: process.env.S3_REGION ?? 'us-east-1',
  bucket: process.env.S3_BUCKET ?? 'trip-media',
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'trip-local',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'trip-local-secret',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  publicUrl: process.env.S3_PUBLIC_URL,
}
const ORIGIN = process.env.VERIFY_ORIGIN ?? 'http://localhost:3000'

const makeClient = (extra = {}) =>
  new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    ...extra,
  })

// Recommended app config: only send/validate checksums when an operation
// requires them (the SDK default "WHEN_SUPPORTED" adds CRC32 checksums).
const s3 = makeClient({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

let failures = 0
const results = []
async function check(name, fn, { optional = false } = {}) {
  try {
    const detail = await fn()
    results.push(['PASS', name, detail ?? ''])
  } catch (err) {
    if (!optional) failures++
    results.push([optional ? 'INFO' : 'FAIL', name, err?.message ?? String(err)])
  }
  const [s, n, d] = results.at(-1)
  console.log(`${s.padEnd(4)}  ${n}${d ? `  -- ${d}` : ''}`)
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const hdr = (res, name) => res.headers.get(name)

const key = `verify/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
const body = `hello from verify-s3 ${new Date().toISOString()} \u{1F30F}`
const bodyBytes = new TextEncoder().encode(body)

console.log(`s3 endpoint=${cfg.endpoint} bucket=${cfg.bucket} region=${cfg.region} pathStyle=${cfg.forcePathStyle} origin=${ORIGIN}\n`)

await check('healthz', async () => {
  const r = await fetch(`${cfg.endpoint}/healthz`)
  assert(r.ok, `status ${r.status}`)
  return `${r.status}`
})

await check('HeadBucket (bucket exists)', async () => {
  await s3.send(new HeadBucketCommand({ Bucket: cfg.bucket }))
})

await check('SDK PutObject + GetObject round trip (server side)', async () => {
  const k = `${key}.sdk`
  await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: k, Body: body, ContentType: 'text/plain; charset=utf-8' }))
  const got = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: k }))
  const text = await got.Body.transformToString()
  assert(text === body, 'body mismatch')
  await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: k }))
  return `ETag ${got.ETag}`
})

const objectUrl = `${cfg.endpoint}/${cfg.bucket}/${key}`

await check('CORS preflight OPTIONS (PUT, content-type) from allowed origin', async () => {
  const r = await fetch(objectUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type,x-amz-meta-trip-id',
    },
  })
  assert(r.status === 200, `status ${r.status}`)
  assert(hdr(r, 'access-control-allow-origin') === ORIGIN, `allow-origin=${hdr(r, 'access-control-allow-origin')}`)
  assert(/\bPUT\b/.test(hdr(r, 'access-control-allow-methods') ?? ''), `allow-methods=${hdr(r, 'access-control-allow-methods')}`)
  assert(/content-type/i.test(hdr(r, 'access-control-allow-headers') ?? ''), `allow-headers=${hdr(r, 'access-control-allow-headers')}`)
  return ['allow-origin', 'allow-methods', 'allow-headers', 'expose-headers']
    .map((h) => `${h}: ${hdr(r, `access-control-${h}`)}`)
    .join(' | ')
})

await check('CORS preflight from a NOT allowed origin is rejected', async () => {
  const r = await fetch(objectUrl, {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'PUT' },
  })
  assert(r.status !== 200 && !hdr(r, 'access-control-allow-origin'), `status ${r.status}, allow-origin=${hdr(r, 'access-control-allow-origin')}`)
  return `${r.status}`
})

await check('presigned PUT (browser-style fetch with Origin + Content-Type)', async () => {
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: 'text/plain; charset=utf-8' }),
    { expiresIn: 300 },
  )
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Origin: ORIGIN, 'Content-Type': 'text/plain; charset=utf-8' },
    body: bodyBytes,
  })
  assert(r.status === 200, `status ${r.status}: ${await r.text()}`)
  assert(hdr(r, 'access-control-allow-origin') === ORIGIN, `allow-origin=${hdr(r, 'access-control-allow-origin')}`)
  assert(/etag/i.test(hdr(r, 'access-control-expose-headers') ?? ''), `expose-headers=${hdr(r, 'access-control-expose-headers')}`)
  return `status ${r.status}, ETag ${hdr(r, 'etag')}`
})

await check('presigned GET returns the same bytes (+ CORS headers)', async () => {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: 300 })
  const r = await fetch(url, { headers: { Origin: ORIGIN } })
  assert(r.status === 200, `status ${r.status}`)
  const text = await r.text()
  assert(text === body, `body mismatch: ${JSON.stringify(text)}`)
  assert(hdr(r, 'access-control-allow-origin') === ORIGIN, `allow-origin=${hdr(r, 'access-control-allow-origin')}`)
  return `status ${r.status}, content-type ${hdr(r, 'content-type')}, ${bodyBytes.length} bytes`
})

await check('presigned HEAD', async () => {
  const url = await getSignedUrl(s3, new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: 300 })
  const r = await fetch(url, { method: 'HEAD', headers: { Origin: ORIGIN } })
  assert(r.status === 200, `status ${r.status}`)
  assert(Number(hdr(r, 'content-length')) === bodyBytes.length, `content-length ${hdr(r, 'content-length')}`)
  return `content-length ${hdr(r, 'content-length')}`
})

await check('presigned PUT with signed content-type+content-length enforces both', async () => {
  const k = `${key}.signed`
  const bytes = new Uint8Array([1, 2, 3, 4])
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: cfg.bucket, Key: k, ContentType: 'image/jpeg', ContentLength: bytes.length }),
    { expiresIn: 300, signableHeaders: new Set(['content-type', 'content-length']) },
  )
  const put = (ct, b) => fetch(url, { method: 'PUT', headers: { Origin: ORIGIN, 'Content-Type': ct }, body: b })
  const wrongType = await put('text/html', bytes)
  const wrongSize = await put('image/jpeg', new Uint8Array(10))
  const good = await put('image/jpeg', bytes)
  await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: k })).catch(() => {})
  assert(wrongType.status === 403, `wrong content-type got ${wrongType.status}`)
  assert(wrongSize.status === 403, `wrong size got ${wrongSize.status}`)
  assert(good.status === 200, `matching upload got ${good.status}`)
  return 'wrong type 403, wrong size 403, exact match 200'
})

await check('tampered presigned URL is rejected', async () => {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: 300 })
  const bad = url.replace(/X-Amz-Signature=([0-9a-f])/, (_, c) => `X-Amz-Signature=${c === '0' ? '1' : '0'}`)
  const r = await fetch(bad)
  assert(r.status === 403, `status ${r.status}`)
  return `${r.status}`
})

await check('expired presigned URL is rejected', async () => {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
    expiresIn: 1,
    signingDate: new Date(Date.now() - 60_000),
  })
  const r = await fetch(url)
  assert(r.status === 403, `status ${r.status}`)
  return `${r.status}`
})

await check(
  'anonymous GET on S3_PUBLIC_URL (informational: private => use presigned GETs)',
  async () => {
    const base = cfg.publicUrl ?? `${cfg.endpoint}/${cfg.bucket}`
    const r = await fetch(`${base}/${key}`)
    assert(r.status === 200, `status ${r.status} (objects are not publicly readable)`)
    return `${r.status} (objects are publicly readable)`
  },
  { optional: true },
)

await check(
  'presigned PUT with SDK default checksums (requestChecksumCalculation=WHEN_SUPPORTED)',
  async () => {
    const def = makeClient()
    const k = `${key}.defaultcrc`
    const url = await getSignedUrl(def, new PutObjectCommand({ Bucket: cfg.bucket, Key: k, ContentType: 'text/plain' }), {
      expiresIn: 300,
    })
    const r = await fetch(url, { method: 'PUT', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: bodyBytes })
    const txt = await r.text()
    await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: k })).catch(() => {})
    assert(r.status === 200, `status ${r.status}: ${txt.slice(0, 200)}`)
    const q = new URL(url).searchParams
    return `status 200; checksum query params: ${[...q.keys()].filter((p) => /checksum/i.test(p)).join(',') || 'none'}`
  },
  { optional: true },
)

await check('cleanup DeleteObject', async () => {
  await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
})

console.log(`\n${failures === 0 ? 'ALL REQUIRED CHECKS PASSED' : `${failures} REQUIRED CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
