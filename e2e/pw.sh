#!/usr/bin/env bash
# Run a command with Playwright wired to the nixpkgs browser bundle.
#   ./pw.sh playwright test            -> run the test suite
#   ./pw.sh node shot.mjs URL out.png  -> screenshot a URL
# Resolves node/pnpm and the browsers from the system nixpkgs registry entry
# and refuses to run if @playwright/test (package.json) != nixpkgs playwright-driver.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

nix_ver="$(nix eval --raw nixpkgs#playwright-driver.version)"
npm_ver="$(sed -n 's/.*"@playwright\/test": *"\([^"]*\)".*/\1/p' package.json)"
if [[ "$nix_ver" != "$npm_ver" ]]; then
  echo "pw.sh: version mismatch: nixpkgs playwright-driver=$nix_ver but package.json pins @playwright/test=$npm_ver" >&2
  echo "pw.sh: fix with: pnpm add -D --save-exact @playwright/test@$nix_ver  (inside nix shell nixpkgs#nodejs_22 nixpkgs#pnpm)" >&2
  exit 1
fi

browsers="$(nix build --no-link --print-out-paths nixpkgs#playwright-driver.browsers)"
export PLAYWRIGHT_BROWSERS_PATH="$browsers"
export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [[ ! -d node_modules/@playwright/test ]]; then
  nix shell nixpkgs#nodejs_22 nixpkgs#pnpm -c pnpm install --frozen-lockfile --ignore-workspace
fi

cmd="$1"; shift || true
case "$cmd" in
  # pnpm too: playwright.app.config.ts's webServer runs `pnpm dev` (SPEC §5.4).
  playwright) exec nix shell nixpkgs#nodejs_22 nixpkgs#pnpm -c node node_modules/@playwright/test/cli.js "$@" ;;
  *)          exec nix shell nixpkgs#nodejs_22 nixpkgs#pnpm -c "$cmd" "$@" ;;
esac
