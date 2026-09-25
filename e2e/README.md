# Yonder e2e

Playwright tests for the app, in their own package. On NixOS they use the browsers nixpkgs builds, so `@playwright/test` must match `nix eval --raw nixpkgs#playwright-driver.version` exactly (`pw.sh` checks this and sets everything up).

## Run the full suite

From the repo root:

```sh
pnpm e2e:fast                                    # everything, desktop + mobile
pnpm e2e:fast tests/app/overview.spec.ts         # one spec
pnpm e2e:fast --envs 4 --retries=1 -g "share"    # any playwright flag works
```

It starts several isolated copies of the app (each with its own database cloned from a pre-seeded template, bucket, Redis prefix and ports), runs one worker per copy, resets the data before every spec file, stops everything afterwards and prints a summary with the failing tests. The number of copies adapts to free memory (default 4).

Flags: `--envs N`, `--rebuild` (refresh the template), `--keep` (leave the envs running), `--baseline <file>` (mark new failures). The HTML report lands in `e2e/playwright-report/fast`, logs in `.data/e2e-fast/`.

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
