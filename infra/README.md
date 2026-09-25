# Local infrastructure

`docker-compose.yml` (in the repo root) runs three services for local dev, plus an optional mail catcher:

| Service | Image | Host address | Data |
|---|---|---|---|
| `postgres` | `postgres:17.11` | `127.0.0.1:5432`, db/user `trip`, password `${POSTGRES_PASSWORD:-trip}` | named volume `trip-planner_pgdata` |
| `s3proxy` | `andrewgaul/s3proxy:4.1.1` | `http://localhost:8080` (S3 API, path-style) | named volume `trip-planner_s3data` (jclouds `filesystem` backend at `/data`) |
| `redis` | `redis:8.10.2-alpine` | `127.0.0.1:6379` (AOF on, `noeviction`) | named volume `trip-planner_redisdata` |
| `mailpit` (profile `mail`) | `axllent/mailpit:v1.31.2` | SMTP `127.0.0.1:1025`, UI `http://localhost:8025` | none |

Every port is bound to **127.0.0.1 only**. Docker bypasses the NixOS firewall, and the credentials are trivial.
Bucket `trip-media` is created automatically on start.

**Redis** carries live trip invalidation (pub/sub `${REDIS_PREFIX}:trip:<id>`), Hocuspocus multi-instance sync,
BullMQ queues (`${REDIS_PREFIX}:bull:*`), Better Auth secondary storage and rate limits, and TTL caches.
`REDIS_URL` points at it; **`REDIS_PREFIX`** (default `yonder`) namespaces every key, channel and queue.
Pub/sub ignores the database number in the URL, so parallel agents sharing this Redis each use their own
prefix (`yonder-a<n>`, written by `pnpm agent:env <n>`), like their own database and bucket.
`pnpm db:reset` deletes only its own prefix (SCAN + UNLINK), never `FLUSHALL`.

**Mail:** without `RESEND_API_KEY` or `SMTP_HOST` the app logs sign-in codes (`[auth] OTP … code=NNNNNN`).
To see real emails, `docker compose --profile mail up -d --wait mailpit` and set `SMTP_HOST=localhost`,
`SMTP_PORT=1025` in `.env`.

The **production-like stack** (profile `prod`: `migrate`, `app`, `collab`, `worker`, `caddy`) only starts
with `docker-compose.prod.yml` via `pnpm prod:up` (SPEC §5.2); a plain `docker compose up` never starts it.

## Commands (run from the repo root)

```sh
cp .env.example .env                 # once, only if there is no .env. Then set BETTER_AUTH_SECRET
docker compose up -d --wait          # start postgres, s3proxy and redis, return once healthy (exit 0)
docker compose ps                    # all three should say (healthy)
docker exec trip-planner-redis-1 redis-cli ping    # PONG
docker compose logs -f s3proxy       # logs
docker compose down                  # stop, keep data
docker compose down -v               # stop and WIPE the database, all objects and Redis (never on a shared machine)

# postgres
docker exec -it trip-planner-postgres-1 psql -U trip -d trip
docker exec trip-planner-postgres-1 psql -U trip -d trip -tAc 'select 1'
# DATABASE_URL=postgres://trip:trip@localhost:5432/trip

# buckets
./infra/create-bucket                # idempotent. Reads ./.env. Needs only curl (>= 7.75, --aws-sigv4)
S3_BUCKET=other ./infra/create-bucket

# verification (see "Verified" below)
pnpm --dir infra install --ignore-workspace       # once (inside `nix shell nixpkgs#nodejs_22 nixpkgs#pnpm`)
nix shell nixpkgs#nodejs_22 -c node infra/verify-s3.mjs       # SDK + presigned + CORS checks
./e2e/pw.sh node ../infra/verify-browser-cors.mjs             # real Chromium CORS check
curl -si -X OPTIONS http://localhost:8080/trip-media/any/key \
  -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-type'
```

`infra/` is a standalone package with its own `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`, like `e2e/`.
It is not part of the app build. pnpm 11 wrote the `minimumReleaseAgeExclude` list into `infra/pnpm-workspace.yaml` because the pinned AWS SDK (3.1138.0, the current `latest`) is newer than pnpm's minimum release age.

## Files

| File | Purpose |
|---|---|
| `../docker-compose.yml` | postgres + s3proxy + redis (+ mailpit, + the `prod` profile), healthchecks, CORS, bucket pre-creation |
| `../docker-compose.prod.yml`, `../Dockerfile`, `../Caddyfile`, `../.dockerignore` | the VPS stack (SPEC §5.2): only Caddy publishes ports |
| `../.env.example` | every env var the app uses, with local defaults. Copy it to `.env` |
| `../.env` | local values (random `BETTER_AUTH_SECRET`). Gitignored, mode 600 |
| `create-bucket` | POSIX sh + curl SigV4. HEAD, then PUT the bucket. Env vars take precedence over `../.env`, then the defaults |
| `verify-s3.mjs` | end-to-end S3 checks with `@aws-sdk/client-s3` and `s3-request-presigner` 3.1138.0 |
| `verify-browser-cors.mjs` | Chromium via Playwright (from `../e2e`, read-only) runs presigned PUT/GET from origin `http://localhost:3000` |

## How s3proxy is configured

The image's `run-docker-container.sh` maps env vars to `s3proxy.*` and `jclouds.*` properties. The ones set here:

- `S3PROXY_ENDPOINT=http://0.0.0.0:80`: the container port. The host maps 8080 to it.
- `S3PROXY_AUTHORIZATION=aws-v2-or-v4`, with `S3PROXY_IDENTITY` and `S3PROXY_CREDENTIAL` taken from `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in `.env`. Compose interpolates them, falling back to `trip-local` / `trip-local-secret`.
- `S3PROXY_VIRTUALHOST=""`: path-style only. Use `forcePathStyle: true` in the SDK.
- `JCLOUDS_PROVIDER=filesystem` and `JCLOUDS_FILESYSTEM_BASEDIR=/data`. A bucket is a directory under `/data` and an object is a file.
- CORS (`S3PROXY_CORS_*`). **Lists are separated by spaces, not commas. Origins are Java regexes matched against the whole Origin value.**
  - `ALLOW_ORIGINS`: `http://localhost:3000 http://127.0.0.1:3000`. Override with `S3_CORS_ORIGINS` in `.env`.
  - `ALLOW_METHODS`: `GET HEAD PUT POST DELETE`. These are the only methods s3proxy supports.
  - `ALLOW_HEADERS`: `*`. The preflight echoes whatever the browser asks for. A literal list cannot express `x-amz-meta-*`.
  - `EXPOSED_HEADERS`: `ETag Content-Length Content-Type Last-Modified x-amz-request-id x-amz-version-id`. The browser needs `ETag` to be exposed for multipart uploads.
- Healthcheck: `GET /healthz` (no auth) over bash `/dev/tcp`. The image has no curl.
- Bucket pre-creation: the service `command` runs `mkdir -p /data/$S3_BUCKET` and then execs the stock start script.
  - I first used a one-shot `s3-init` container, but it made `docker compose up --wait` exit 1 (`container ... exited (0)`), so I dropped it.

## Verified (2026-09-22)

- `docker compose up -d --wait` exits 0. Both containers are healthy.
- `docker exec ... psql -c 'select 1'` returns `1`. `DATABASE_URL` works from the host network: `trip|trip|17.11`.
- Bucket: created through the S3 API by `create-bucket` (PUT, then HEAD 200 on a second run, which is idempotent). With wrong credentials it exits 1 after a 403. After deleting the `s3data` volume and restarting, the bucket exists again (HEAD 200).
- `node infra/verify-s3.mjs`: all required checks pass:
  - `HeadBucket`
  - SDK `PutObject`/`GetObject` round trip
  - preflight from `http://localhost:3000`: 200 with `Access-Control-Allow-Origin: http://localhost:3000`, methods, echoed headers and exposed headers
  - preflight from another origin: 403
  - presigned PUT: 200, with ACAO and exposed ETag
  - presigned GET: same bytes back
  - presigned HEAD: works
  - signed content-type and content-length are enforced
  - tampered signature: 403
  - expired URL: 403
- Real Chromium 148: a PUT from `http://localhost:3000` returns 200, the ETag is readable from JS, and the GET body matches. From `http://localhost:4000` both requests are blocked by CORS.

## Findings the app code should follow

1. **S3 client config**:
   ```ts
   new S3Client({
     endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION,
     forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
     credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
     requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
   })
   ```
   With the SDK default (`WHEN_SUPPORTED`), presigned PUT URLs carry `x-amz-checksum-crc32` of the *empty* body plus `x-amz-sdk-checksum-algorithm`. s3proxy ignores them, so the PUT works locally, but S3-compatible services that validate them will reject the upload. `WHEN_REQUIRED` keeps the URLs clean.
2. **Presigned PUT only signs `host` by default.** Content-Type and size are *not* enforced, and a URL signed for `image/jpeg` accepts `text/html`. To pin both, pass
   `getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType, ContentLength }), { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) })`.
   The browser must then send exactly that `Content-Type` (it sets Content-Length itself). s3proxy returns 403 on a mismatch, as S3 does.
3. **Do not send `x-amz-meta-*` headers from the browser.** Unsigned ones get 403. `Metadata` passed to the presigned command is moved into the query string and accepted, but **s3proxy does not store it** (`HeadObject` returns `{}`). Keep media metadata (trip id, uploader, dimensions) in Postgres.
4. **Objects are private.** An anonymous GET on `S3_PUBLIC_URL/<key>` returns 403. Serve media with presigned GET URLs, or proxy them through the app. `S3_PUBLIC_URL` is only the base for building and recognising object URLs.
5. A preflight (`OPTIONS`) on a bucket that doesn't exist returns 403, not CORS headers. If uploads fail after `down -v`, restart s3proxy or run `./infra/create-bucket`.
6. The CORS origin must match exactly. `http://127.0.0.1:3000` is allowed as well. For any other dev origin (for example a LAN IP for phone testing), set `S3_CORS_ORIGINS` in `.env` to a space-separated list and run `docker compose up -d`. To reach it from a phone you would also need to change the `127.0.0.1:` port bindings.
7. For browser tests with Playwright `page.route`-fulfilled pages: Chrome 142+ Local Network Access classifies such pages as public and blocks their fetches to localhost. Launch with `--disable-features=LocalNetworkAccessChecks` (as `verify-browser-cors.mjs` does). A real dev server on localhost:3000 is not affected.
8. No global openssl on this NixOS box. Generate a secret with `head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n'`.
