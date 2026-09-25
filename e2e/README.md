# Yonder e2e: browser automation on NixOS

This is a standalone Playwright harness with its **own** `package.json`, kept apart from the app's.
It uses the browsers that nixpkgs builds (`playwright-driver.browsers`). Nothing gets downloaded with `playwright install`.

Tested on 2026-09-22 (NixOS, node 22, pnpm 11.5.3):
`8 passed`. That covers chromium, mobile (Pixel 7), firefox and webkit, on the local fixture and on https://example.com.

## Why this setup

| Option | Result |
|---|---|
| **nixpkgs `playwright-driver.browsers` + npm `@playwright/test` pinned to the same version** | **Works.** All 4 engines (chromium, chromium-headless-shell, firefox, webkit) run headless. This is the one we use. |
| System firefox (`/run/current-system/sw/bin/firefox`) via `firefox.launch({executablePath})` | **Fails.** You get `browserType.launch: Failed to launch the browser process`, because Playwright needs its patched Firefox (Juggler) and stock Firefox doesn't have it. |
| `npx playwright install` | Doesn't work on NixOS: the downloaded binaries are dynamically linked against FHS paths. |

**Version pin rule:** `@playwright/test` in `package.json` must **exactly** equal `nix eval --raw nixpkgs#playwright-driver.version`, which is currently `1.60.0`.
Each Playwright release expects specific browser revisions (chromium-1223, firefox-1522, webkit-2287 here).
`pw.sh` checks the versions before every run and refuses to start if they differ. `nixpkgs` resolves to the system flake registry entry, so it only moves when the system is rebuilt.
If it does move, re-pin with:

```sh
nix shell nixpkgs#nodejs_22 nixpkgs#pnpm -c pnpm add -D --save-exact @playwright/test@$(nix eval --raw nixpkgs#playwright-driver.version)
```

## Files

- `pw.sh`: env wrapper. It checks the version match, runs `nix build nixpkgs#playwright-driver.browsers` (cached after the first run) and exports
  `PLAYWRIGHT_BROWSERS_PATH=<that store path>`, `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. It runs `pnpm install` if needed, then runs the command under `nix shell nixpkgs#nodejs_22`.
- `playwright.config.mjs`: projects `chromium` (Desktop Chrome 1280x720), `mobile` (Pixel 7), `firefox` and `webkit`. It is headless by default.
  If `E2E_BASE_URL` is unset, it serves `fixtures/` on `127.0.0.1:4599` with `python3 -m http.server`. Override the port with `E2E_FIXTURE_PORT`.
  Avoid ports 631, 6463, 8081 and 9292, which are already in use on this machine.
- `tests/smoke.spec.mjs`: proves the harness works. It loads the fixture, clicks a button, checks the result and takes a screenshot, then loads example.com and screenshots it.
- `shot.mjs`: reusable screenshot CLI (see below).
- Output (all gitignored): `test-results/` holds per-test output and screenshots, `playwright-report/` holds the HTML report and `shots/` holds `shot.mjs` output.

## Install (one-time; `pw.sh` also does it automatically)

```sh
cd e2e
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 nix shell nixpkgs#nodejs_22 nixpkgs#pnpm -c pnpm install
```

## Run the tests (headless is the default)

```sh
cd e2e
./pw.sh playwright test                                   # all 4 projects
./pw.sh playwright test --project chromium --project mobile
./pw.sh playwright test tests/smoke.spec.mjs -g fixture   # filter by file / title
E2E_OFFLINE=1 ./pw.sh playwright test                     # skip the example.com test
./pw.sh playwright show-report playwright-report          # open the HTML report
```

The same commands are available as pnpm scripts. Run them inside `nix shell nixpkgs#nodejs_22 nixpkgs#pnpm -c ...`:
`pnpm test`, `pnpm run test:chromium`, `pnpm run test:headed`, `pnpm run report` and `pnpm shot <url> <out.png>`.

**Headless vs headed:** the config sets `headless: true`, so tests run with no display (over SSH, in CI and in agents).
To watch a run on the desktop session, use `./pw.sh playwright test --headed --project chromium`, or `--debug` for the inspector.
The headed modes need a running Wayland/X session.

**Against the real app:** start the dev server first, then run:

```sh
E2E_BASE_URL=http://localhost:3000 ./pw.sh playwright test
```
Use `localhost`, not `127.0.0.1`: `pnpm dev` binds only `::1` on this machine, so `127.0.0.1:3000` refuses connections (or start it with `pnpm dev --host`). `shot.mjs` waits for `load` plus at most 5 s of network idle, because the Vite dev server never goes fully idle.


When `E2E_BASE_URL` is set, the fixture server doesn't start. In tests, `page.goto('/')` resolves against the base URL.

**The app's specs (`playwright.app.config.ts`, `pnpm e2e`) never run against the main stack** (:3000, database `trip`, bucket `trip-media`, Redis prefix `yonder`: the owner's real trips). They write test data, so they run on an isolated stack from `pnpm agent:env <n>`; the config, the writing helpers and the server's `/api/test/*` routes all refuse the main stack (see the root README, "Tests never touch the main stack"). `E2E_ALLOW_MAIN=1` overrides only the harness's check.

## Fast full run: `pnpm e2e:fast`

The whole app suite on several isolated app envs at once, one Playwright worker per env. Run it from the repo root:

```sh
nix shell nixpkgs#nodejs_22 nixpkgs#pnpm -c pnpm e2e:fast                       # everything, chromium + mobile
nix shell nixpkgs#nodejs_22 nixpkgs#pnpm -c pnpm e2e:fast tests/app/qa-money-core.spec.ts --project chromium
nix shell nixpkgs#nodejs_22 nixpkgs#pnpm -c pnpm e2e:fast --envs 4 --baseline .data/e2e-baseline-failures.txt
```

What it does (`scripts/e2e-fast.ts`):

1. Starts the compose service `postgres-e2e` (:5433, fsync off, 800 connections; stopped again after the run).
2. Builds the template database `trip_e2e_tmpl` when it is stale (`scripts/e2e-template.ts`; fingerprint of `drizzle/`, the seed code and data, the harness; or older than 4 days).
   It holds migrations, the demo seed and `db:seed:qa --no-media --no-auth` with its autofill jobs done, plus the sessions of the demo and QA users.
   So one set of storageStates (`.data/e2e-fast/auth`, `.data/e2e-fast/qa-auth`) works on every env: cookies ignore the port and every env shares `BETTER_AUTH_SECRET`.
3. Clones N databases from it and starts N envs, each `vite dev` plus collab with the BullMQ worker in-process (`COLLAB_RUN_WORKER=1`), no file watching.
   Env i gets app :7100+10i, collab :7101+10i, database `trip_e2e_<i>`, bucket `trip-media-e2e<i>`, Redis prefix `yonder-e2e<i>`, its own outbox and log in `.data/e2e-fast/env-<i>/`, `DEV_FIXED_OTP=000000`, `ENABLE_TEST_ROUTES=1`, `VITE_E2E=1`.
4. Runs `playwright.fast.config.ts`: worker slot i only talks to env i+1 (`tests/app/_helpers/fast-env.ts` sets its `process.env` before any spec loads).
   Global setup warms every env up (a fresh `vite dev` compiles each page on first use).
   Before the first hook or test of each spec file, the worker resets its env to the template: `e2e_snap.reset()` in the database (about 20 ms) and its Redis prefix (`tests/app/_helpers/fast-test.ts`, which `tsconfig.fast.json` puts behind `@playwright/test`).
   A spec never sees another spec's leftovers (shifted dates, trip copies, prefs); tests within one file still share data, as before.
5. Stops the servers (also on Ctrl-C) and prints the wall time, the counts and the failing tests (`project | file | title`; `--baseline <file>` marks the new ones).

- **Memory:** the machine is shared. N defaults to 4 and is capped at `floor((available GB - 16) / 2)`. The run refuses to start below 20 GB available and stops itself below 5 GB (`E2E_FAST_ABORT_BELOW_GB`).
  Each env costs 3 to 4 GB at peaks: vite dev about 1.6 GB, collab 0.35 GB, and its Playwright worker plus Chromium 1 to 2 GB (multi-user specs with maps).
- **CPU:** Chromium draws the MapLibre maps in software (SwiftShader). At 6 envs the load was about 25 on 32 threads; at 12 it was 44, and the tests only got slower. More envs don't help much on this machine.
- **Flags:** `--envs N`, `--rebuild` (template), `--keep` (leave the envs up; the next run stops them), `--baseline <file>`. Everything else goes to `playwright test`, for example `--retries=1`, `-g`, `--project`.
- **Output:** the report is in `e2e/playwright-report/fast`. `.data/e2e-fast/report.json` is the JSON the summary reads, and `.data/e2e-fast/env-<i>/{app,collab}.log` are the env logs (`E2E_APP_LOG`).
- **Specs** need nothing new: they read the same variables as before (`APP_URL`, `E2E_APP_LOG`, `QA_AUTH_DIR`, `DATABASE_URL`, …).
  The fast config runs each file in one worker, its tests in order (`fullyParallel: false`), so tests that build on earlier tests of the same file keep working.
  If a test fails, the rest of the file goes on in a fresh worker on the same data: the env remembers which file its data belongs to (`e2e_snap.state`).
  A spec must not rely on another spec FILE having run first. For example, the PDF specs call `_helpers/qa-pdfs.ts` instead of relying on qa-content-17's uploads.
  `qa-content-00-auth.spec.ts` is skipped (the template signs the QA users in).
- **Provider caches survive the reset:** the `climate_normals` and `fx_rates` tables (the template already holds today's rates and the seeded cities' normals) and Redis `<prefix>:cache:*`.
- **Fallback:** the single-env runner below (`pnpm e2e` on one `pnpm agent:env <n>` stack) still works unchanged.

## Screenshot a URL: `shot.mjs`

```sh
./pw.sh node shot.mjs <url> <out.png> [--mobile] [--browser chromium|firefox|webkit]
                      [--full] [--width N] [--height N] [--wait-for <css>] [--delay ms] [--dark]
```

```sh
# desktop (chromium, 1440x900 viewport, DPR 1)
./pw.sh node shot.mjs https://example.com shots/desktop.png
# mobile (Pixel 7 emulation: 412x839 viewport, DPR 2.625, touch, mobile UA → 1082x2202 PNG)
./pw.sh node shot.mjs https://example.com shots/mobile.png --mobile
# full-page, iPhone 15 on webkit, dark color scheme
./pw.sh node shot.mjs http://localhost:3000/ shots/iphone.png --mobile --browser webkit --full --dark
# custom viewport, wait for the app to render something first
./pw.sh node shot.mjs http://localhost:3000/trip shots/tablet.png --width 820 --height 1180 --wait-for '[data-testid=itinerary]'
```

The script waits for `networkidle`, always runs headless, creates the output directory, and prints the absolute path, engine, viewport and HTTP status.
With `--mobile`, firefox only gets a 390x844 viewport with touch, because Playwright's firefox doesn't support `isMobile`.
