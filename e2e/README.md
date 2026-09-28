# Yonder e2e

Playwright tests for the app, in their own package. On NixOS they use the browsers nixpkgs builds, so `@playwright/test` must match `nix eval --raw nixpkgs#playwright-driver.version` exactly (`pw.sh` checks this and sets everything up).

## Run the full suite

From the repo root:

```sh
pnpm e2e:fast                                    # everything, desktop + mobile
pnpm e2e:fast tests/app/overview.spec.ts         # one spec
pnpm e2e:fast --envs 4 --retries=1 -g "share"    # any playwright flag works
pnpm e2e:smoke                                   # ~110 tests over the main flows, ~6 min
pnpm e2e:affected [ref]                          # smoke + specs whose feature changed since ref (default HEAD)
pnpm e2e:smoke --frozen                          # test HEAD from ../trip-planner-e2e; keep editing meanwhile
```

The smoke set lives in `scripts/lib/e2e-select.ts`.

It starts several isolated copies of the app (each with its own database cloned from a pre-seeded template, bucket, Redis prefix and ports), runs one worker per copy, resets the data before every spec file, stops everything afterwards and prints a summary with the failing tests. The number of copies adapts to free memory (default 4).

Flags: `--envs N`, `--rebuild` (refresh the template), `--keep` (leave the envs running), `--baseline <file>` (mark new failures). The HTML report lands in `e2e/playwright-report/fast`, logs in `.data/e2e-fast/`.

## Offline

`e2e:fast` and vitest never reach a service outside this machine: no quotas spent, no mail sent, the same answers every day.

**Stubbed.** `e2e:fast` starts `stubs/services-stub.mjs` on :7099 and points every env at it (`offlineOverrides` in `scripts/lib/e2e-fast.ts`):

- Open-Meteo, Overpass, OSRM and FX rates: made-up but plausible answers.
- Photon (`photon-stub.mjs`): real answers recorded once in `stubs/fixtures/photon.json`, plus the seed's places (`seed/data/geocode-hints.json`) for the importer.
- Whatever the server fetches for a pasted or shared URL (`link-stub.mjs`): pages, YouTube/TikTok oEmbed, Instagram, Google Maps, short links, preview images, favicons. The SSRF-safe fetch asks the stub instead of the host (`E2E_OUTBOUND_STUB`, test switches only).
- The basemap (`map-proxy.mjs`): OpenFreeMap and Esri from `.data/e2e-fast/map-cache` (`VITE_MAP_PROXY_URL`). An uncached tile is blank, never an error.
- Video players in the browser: a black placeholder page.
- Off: Google Places/Routes (no key), Resend/SMTP (the outbox), Turnstile, Web Push, telemetry. Postgres, Redis and S3 must be local.

**Guards.** Every Node process of an env (vite, collab and its worker, template scripts, what a spec spawns, the Playwright workers) loads `scripts/no-egress-preload.mjs`: a connection or DNS lookup off loopback is refused, logged with its stack to the env's `app.log`, and fails the run. In the browser, `tests/app/_helpers/egress.ts` aborts requests to outside hosts (Chromium also resolves only localhost) and fails the test that made one. Vitest (`src/test/no-network.ts`) fails any test that reaches the network. `e2e:fast` ends with each service's stub misses and every refusal: all 0 is the goal.

**Warm the tile cache** once, and when the specs browse somewhere new: `pnpm e2e:tiles:warm [--smoke | specs…]` runs the suite while the proxy fetches what it lacks, one request at a time, 4 a second at most. Only browsed tiles are fetched (OpenFreeMap's terms forbid bulk prefetching).

**Re-record a fixture.** Photon: add the query to `scripts/e2e-record-photon.ts`, then `pnpm e2e:photon:record` (only missing entries, one a second; `--force` for all). Links: edit `stubs/fixtures/links.json` (pages, video titles, short links); any other page on a host listed there or in the seed data gets a title from its URL.

The single-env `pnpm e2e` below still uses whatever services its dev server is configured with.

## Run against one env

The single-env runner still works, e.g. while writing a spec:

```sh
pnpm agent:env 61 --out .data/agent-61.env && set -a && . .data/agent-61.env && set +a
pnpm db:create
ENABLE_TEST_ROUTES=1 VITE_E2E=1 pnpm dev > .data/agent-61-dev.log 2>&1 &
E2E_APP_LOG=$PWD/.data/agent-61-dev.log pnpm e2e -- tests/app/overview.spec.ts
```

The `qa-*` specs also need `pnpm db:seed:qa` and the QA logins (`pnpm e2e -- tests/app/qa-content-00-auth.spec.ts --project chromium`) first.

## Rules

- **Never against your dev data.** The harness and the server refuse to run tests on the main stack (`:3000`, database `trip`, bucket `trip-media`, Redis prefix `yonder`).
- **Specs stand alone.** A spec file may build on its own earlier tests, never on another file having run.

## Screenshots

```sh
cd e2e && ./pw.sh node shot.mjs <url> <out.png> [--mobile] [--full] [--dark] [--browser firefox|webkit]
```
