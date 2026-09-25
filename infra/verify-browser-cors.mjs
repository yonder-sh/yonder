// Real-browser CORS check: Chromium loads a page whose origin is
// http://localhost:3000 (served by Playwright route interception, so nothing
// has to listen on :3000) and does presigned PUT/GET against s3proxy.
// Unlike node fetch, the browser actually enforces CORS/preflight.
//
// Uses the Playwright + nixpkgs browsers from ../e2e (read-only):
//   ./e2e/pw.sh node ../infra/verify-browser-cors.mjs
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GetObjectCommand, PutObjectCommand, S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const here = dirname(fileURLToPath(import.meta.url))
const envFile = join(here, '..', '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const { chromium } = createRequire(join(here, '..', 'e2e', 'package.json'))('@playwright/test')

const bucket = process.env.S3_BUCKET ?? 'trip-media'
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:8080',
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'trip-local',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'trip-local-secret',
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

const key = `verify/browser-${Date.now()}.txt`
// Recommended app pattern: sign content-type AND content-length so the URL
// only accepts exactly the file the server agreed to (s3proxy enforces both).
const payload = 'from http://localhost:3000'
const put = await getSignedUrl(
  s3,
  new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'text/plain', ContentLength: payload.length }),
  { expiresIn: 300, signableHeaders: new Set(['content-type', 'content-length']) },
)
const get = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 })

// A route-fulfilled page has no IP address, so Chrome (142+) classifies it as
// "public" and its Local Network Access check blocks requests to loopback
// before CORS is even evaluated. The real dev server on localhost:3000 is
// loopback -> loopback (no LNA prompt), so disable only that check here.
const browser = await chromium.launch({
  args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWarn'],
})
const page = await browser.newPage()
const consoleErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
const html = '<!doctype html><title>cors probe</title><p>probe</p>'
await page.route(/^http:\/\/localhost:(3000|4000)\//, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: html }),
)

async function probe(origin) {
  await page.goto(`${origin}/`)
  return page.evaluate(
    async ({ put, get }) => {
      const out = { origin: location.origin }
      try {
        const r = await fetch(put, {
          method: 'PUT',
          // PUT is not a CORS-safelisted method => the browser preflights it.
          // Do NOT add x-amz-meta-* headers: unsigned ones get 403.
          headers: { 'Content-Type': 'text/plain' },
          body: `from ${location.origin}`,
        })
        out.put = r.status
        out.etag = r.headers.get('etag') // only readable if exposed
      } catch (e) {
        out.put = `blocked: ${e.message}`
      }
      try {
        const r = await fetch(get)
        out.get = r.status
        out.body = await r.text()
      } catch (e) {
        out.get = `blocked: ${e.message}`
      }
      return out
    },
    { put, get },
  )
}

let ok = true
const allowed = await probe('http://localhost:3000')
console.log('allowed origin  ', JSON.stringify(allowed))
if (!(allowed.put === 200 && allowed.get === 200 && allowed.body === 'from http://localhost:3000' && allowed.etag)) ok = false

const denied = await probe('http://localhost:4000')
console.log('other origin    ', JSON.stringify(denied))
if (!(String(denied.put).startsWith('blocked') && String(denied.get).startsWith('blocked'))) ok = false

console.log(`browser ${browser.version()}`)
for (const e of consoleErrors) console.log(`  console: ${e.slice(0, 200)}`)
await browser.close()
await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
console.log(ok ? 'BROWSER CORS OK' : 'BROWSER CORS FAILED')
process.exit(ok ? 0 : 1)
