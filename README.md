# Yonder

Plan trips together. [yonder.sh](https://yonder.sh)

- **One plan everyone shares:** places in a tree (country › region › city › area › place), a day-by-day timeline with real travel times, and a live map, all edited together in real time.
- **Decide together:** collect ideas, rate them, and turn the shortlist into days.
- **Everything in one place:** flights, stays, photos, PDFs, lists, notes, budgets and shared expenses.
- **A trip overview** to get excited about, with share cards for your story.
- Roles from owner to viewer, suggestions for review, and a link to share with anyone.

**Stack:** TanStack Start (React 19, Vite, Nitro), Tailwind + shadcn, Postgres (Drizzle), Redis (pub/sub, BullMQ), S3-compatible storage, Hocuspocus + Yjs, MapLibre.

## Run it locally

Needs Node 22, pnpm and Docker.

```bash
cp .env.example .env            # set BETTER_AUTH_SECRET; the rest defaults to local services
docker compose up -d --wait     # postgres, s3proxy and redis on localhost
pnpm install
pnpm db:create                  # migrate and seed a demo trip
pnpm dev                        # app on http://localhost:3000 (+ collab server and job worker)
```

Sign in with any email. With `DEV_FIXED_OTP=000000` in `.env` the code is always `000000` (localhost only); otherwise it's printed in the log.

## Tests

```bash
pnpm typecheck && pnpm check && pnpm test     # types, lint, unit + db tests
pnpm e2e:fast                                 # full Playwright suite on isolated, parallel envs
```

Tests never touch your dev data: they run on their own databases, buckets and Redis prefixes, and refuse to start against the main stack. See [`e2e/README.md`](e2e/README.md).

The landing page (`/`) shows real screenshots of an invented trip: `pnpm landing:shots` seeds it in an isolated env, captures every screen with Playwright and writes `public/landing/`. `pnpm landing:globe` redraws the hero globe's land layer and `public/og.png`.

## Deploy

The `Dockerfile` builds two images: `app` (web server, plus the migrate / bucket-setup / quota scripts) and `collab` (the realtime server and the job worker). `.github/workflows/build.yml` builds, signs and pushes them to GHCR on every push to `main`. Production runs on Kubernetes; the configuration a deployment needs is listed in [`.env.example`](.env.example).

## Credits

Place photos in `seed/media` are from Wikimedia Commons under their own licences ([`seed/media/LICENSES.md`](seed/media/LICENSES.md)). Fonts are under the SIL Open Font License: their notices ship with the app in [`public/licenses/fonts.txt`](public/licenses/fonts.txt), and the font files in the repo sit next to their `OFL-*.txt`. Map data © OpenStreetMap contributors, tiles by OpenFreeMap.
