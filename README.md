# Shit Go Where API

NestJS 12 (ESM) + Prisma 7 + PostgreSQL backend for **Shit Go Where**, a Singapore public toilet
finder: find, rate, contribute and route to toilets. It owns the database, Google auth, imports,
moderation and gamification. The frontend (separate repo) reaches it through a Next.js `/api/*`
rewrite, so in production the browser never talks to this service directly.

Design and roadmap: [`../PLAN.md`](../PLAN.md). Endpoint contract: [`API_CONTRACT.md`](API_CONTRACT.md).
First production deploy: [`../DEPLOY.md`](../DEPLOY.md). Operations (incidents, rollback, restore,
secret rotation, takedowns, bans): [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md).

- Stack: NestJS 12, TypeScript 6, Prisma 7.10 (`prisma-client` generator + `@prisma/adapter-pg`),
  zod via `nestjs-zod`, vitest, oxlint, pnpm 12, Node 24.
- Hosting: Vercel Hobby (`sin1`), Neon Postgres (`ap-southeast-1`), Cloudflare R2 for photos,
  GitHub Actions for CI and all scheduled work.

## Local setup

Requirements: Node 24, pnpm 12 (`corepack enable` or `npm i -g pnpm@12`), Docker.

```bash
docker compose up -d db        # Postgres 17 on localhost:5433 (5432 is left for a native Postgres)
pnpm install                   # also runs `prisma generate`
cp .env.example .env           # defaults already point at the compose DB on 5433
pnpm db:deploy                 # apply committed migrations (or `pnpm db:migrate` while changing the schema)
pnpm db:seed                   # load the curated toilets
pnpm start:dev                 # http://localhost:4000
```

- Swagger UI: <http://localhost:4000/docs>, raw spec: <http://localhost:4000/openapi.json>
- Health: <http://localhost:4000/health> (database) and <http://localhost:4000/health/live> (no database)
- Dev login without Google: `POST /auth/dev-login {"email":"you@example.com"}` while
  `DEV_LOGIN_ENABLED=true` (refused at boot when `NODE_ENV=production`).
- `pnpm openapi` writes `openapi.json` without starting the server; the frontend's `pnpm gen:api`
  generates its typed client from it.

Run the frontend next to it (`API_ORIGIN=http://localhost:4000 pnpm dev` in `../frontend`) and
use <http://localhost:3000>.

### Scripts

| Script | What it does |
|---|---|
| `pnpm start:dev` | Watch mode on `PORT` (4000) |
| `pnpm build` / `pnpm start:prod` | `prisma generate && nest build`, then `node dist/main.js` |
| `pnpm lint` / `pnpm typecheck` | oxlint (type-aware) / `tsc --noEmit` |
| `pnpm test` / `pnpm test:e2e` | vitest unit / e2e (e2e needs a migrated DB) |
| `pnpm openapi` | Write `openapi.json` |
| `pnpm db:up` | `docker compose up -d db` |
| `pnpm db:migrate` | `prisma migrate dev` (create + apply a migration) |
| `pnpm db:deploy` | `prisma migrate deploy` (apply committed migrations only) |
| `pnpm db:seed` | `prisma db seed` (`tsx prisma/seed.ts`; also syncs badges) |
| `pnpm db:sync-badges` | Upsert the badge definitions (`src/gamification/badges.ts`) into `Badge`; idempotent |
| `pnpm db:reset` | Drop, re-migrate and re-seed the local DB |
| `pnpm cli <command>` | Data pipeline, see below |
| `pnpm vercel-build` | Vercel build: `prisma generate`, `prisma migrate deploy`, `nest build`, `node dist/sync-badges.js`. The two database steps go through `scripts/vercel-migrate.mjs`, which skips them on a Preview deployment unless `PREVIEW_DB=1` (set per git branch by `preview-db.yml`) |

## Migration rules

- The schema changes **only** through `pnpm db:migrate` (`prisma migrate dev --name <change>`),
  which writes a new folder under `prisma/migrations/`. Commit it in the same PR as the code
  that needs it.
- **Never edit or delete a migration that has been applied anywhere** (main, a preview branch,
  production). Fix forward with a new migration.
- Never use `prisma db push` against shared databases.
- Prefer additive changes (new nullable columns, new tables). When the frontend needs the change,
  ship the backend PR first, then regenerate the client in the frontend (PLAN.md §9.4).
- CI fails if `schema.prisma` and `prisma/migrations` disagree
  (`prisma migrate diff --from-migrations ... --to-schema ... --exit-code` against a shadow DB).
- `prisma migrate deploy` runs in the Vercel build, so a failing migration blocks the deploy.
  Migrations and seeding use `DIRECT_URL`; the app at runtime uses `DATABASE_URL`.

## Data pipeline

All commands run with `pnpm cli <command>` against `DIRECT_URL` (falls back to `DATABASE_URL`).
Details, sources and licences: [`data/README.md`](data/README.md).

| Command | Purpose |
|---|---|
| `sheet:fetch` | Download the fieldwork sheet export |
| `sheet:normalise` | Clean and normalise rows into the curated JSON |
| `geocode` | Resolve addresses to lat/lng via OneMap |
| `enrich` | Attach venue, MRT exit and area data |
| `seed:fieldwork` | Load the curated fieldwork toilets into the DB |
| `survey2:fetch` / `survey2:normalise` / `survey2:match` | Expanded Aug-Oct 2024 survey: download, curate, match venues and pilot toilets (review the output) |
| `seed:fieldwork-2024b` | Load the expanded survey into the DB (after `seed:fieldwork`) |
| `survey2:photos [--dry-run\|--run]` | Expanded survey Drive photos; dry run by default (the links are not shared yet) |
| `import:osm` | Import / refresh OpenStreetMap toilets (ODbL, attributed) |
| `import:datagov --dataset <name\|all>` | Import data.gov.sg datasets (hawker centres, CCs, parks ...) |
| `import:wikidata` | Import MRT/LRT stations from Wikidata |
| `recompute-scores` | Recompute toilet scores and rankings |
| `levels:backfill [--dry-run]` | Normalise every non-OSM `Toilet.level` and fill `levelOrder` (once, see below) |
| `all` | Run the whole first-cut pipeline in order |

**After deploying the `level_order` migration**, once, against production (`DIRECT_URL`):

1. `pnpm cli levels:backfill` normalises community, fieldwork and admin levels ("level 3" -> "L3")
   and fills `levelOrder`. It skips OSM toilets and says how many.
2. `pnpm cli import:osm` (or Actions -> **Scheduled** -> `weekly-osm`). The old importer stored
   OSM's own floor numbers ("0" for the ground floor, "0;1"), which read one floor low; the import
   rewrites those rows from their tags. Until it runs, OSM toilets show no floor order on the map.

Scheduled runs (GitHub Actions, `.github/workflows/scheduled.yml`): weekly `import:osm` +
`recompute-scores`; monthly `import:datagov --dataset all` + `import:wikidata`; nightly
maintenance endpoints and a database backup. Any job can be started by hand from the Actions tab
(**Scheduled** -> Run workflow -> pick a job).

## Environment variables

Validated at boot by `src/config/env.ts`; the app refuses to start on invalid config.

| Variable | Required | Local default | Production value |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgresql://sgw:sgw@localhost:5433/sgw` | Neon **pooled** URL (`-pooler` host, `?sslmode=require`) |
| `DIRECT_URL` | for migrations/seed/CLI | same as above | Neon **direct** URL (non-pooler host). Needed at **build** time too: `pnpm vercel-build` runs `prisma migrate deploy` and the badge sync with it |
| `DATABASE_URL_UNPOOLED` | no | unset | What Neon's Vercel integration injects instead of `DIRECT_URL`; `prisma.config.ts` and the CLI fall back to it (order: `DIRECT_URL`, `DATABASE_URL_UNPOOLED`, `DATABASE_URL`). Not read by `env.ts` |
| `SHADOW_DATABASE_URL` | local `db:migrate`, CI | unset | Scratch database for `prisma migrate diff` / `migrate dev`; never set on Vercel |
| `PORT` | no | `4000` | not needed on Vercel |
| `NODE_ENV` | no | `development` | Vercel sets `production` |
| `FRONTEND_ORIGIN` | no | `http://localhost:3000` | frontend origin (CORS for Swagger/local tools only; the browser reaches the API through the same-origin rewrite) |
| `PUBLIC_APP_URL` | **yes in production** (the default is localhost) | `http://localhost:3000` | final frontend origin, e.g. `https://shitgowhere.com`; OAuth redirect is `PUBLIC_APP_URL/api/auth/callback`, and every bot/email link derives from it |
| `AUTH_SECRET` | yes, 16+ chars | `change-me-...` | `openssl rand -base64 48` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Google login | empty | Google OAuth web client |
| `ONEMAP_EMAIL` / `ONEMAP_PASSWORD` | for routing + geocoding | empty | OneMap account |
| `S3_ENDPOINT` | for photos | empty | `https://<account-id>.r2.cloudflarestorage.com` (omit for AWS S3) |
| `S3_REGION` | no | `auto` | `auto` (R2) |
| `S3_BUCKET` | for photos | empty | photo bucket name; **private** (photos are read through `GET /media/photos/:id`, which redirects to a presigned GET) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | for photos | empty | R2 API token scoped to the photo bucket |
| `ADMIN_EMAILS` | no | `you@example.com` | comma-separated; promoted to ADMIN at **every** login (removing an address does not demote; see RUNBOOKS 8) |
| `CRON_SECRET` | for `/admin/jobs/*` | `change-me` | random; same value as the GitHub secret |
| `API_PROXY_SECRET` | recommended | empty | `openssl rand -hex 32`; the **same value** in the frontend project. The Next `/api` rewrite sends it with each phone's IP (`x-sgw-client-ip`); without it Vercel's proxy hides the client IP and every visitor shares one rate-limit bucket |
| `DEV_LOGIN_ENABLED` | no | `true` | **unset** (boot fails if `true` in production) |
| `SENTRY_DSN` | recommended | empty (Sentry off) | `sgw-backend` project DSN (Sentry org `shit-go-where`, US region `ingest.us.sentry.io`), set for Production and Preview. Unset = SDK never initialised, nothing sent (see Observability) |
| `POSTHOG_KEY` / `POSTHOG_HOST` | no | empty / `https://us.i.posthog.com` | PostHog project key (US cloud) for server-side events (check-ins, reports, ...). Unset = nothing is sent |
| `TELEGRAM_BOT_TOKEN` | for the bot | empty (bot off) | BotFather token; unset = no bot, no webhook route |
| `TELEGRAM_WEBHOOK_SECRET` | for the webhook | empty | 32+ random chars (`openssl rand -hex 32`) |
| `TELEGRAM_BOT_USERNAME` | for links | empty | bot username without `@`; needed for `/me` "Connect Telegram" and group deep links |
| `TELEGRAM_CHANNEL_ID` | no | empty | broadcast channel (v1.5, unused in v1) |
| `TELEGRAM_API_ROOT` | no | empty | leave unset (tests and local stubs only) |

## Telegram bot

A module in this API (`src/integrations/telegram/`, plan in [`../BOT.md`](../BOT.md)), built on
[grammY](https://grammy.dev). With `TELEGRAM_BOT_TOKEN` unset it registers nothing. It calls the
recommend, OneMap search, check-in and status services in-process; all links derive from
`PUBLIC_APP_URL`.

- **Webhook:** `POST /integrations/telegram`, not throttled and not in `openapi.json`. Telegram
  sends `X-Telegram-Bot-Api-Secret-Token`, compared with `TELEGRAM_WEBHOOK_SECRET` (401 otherwise,
  503 when the secret is unset). The reply is sent before the 200, so nothing runs after Vercel
  freezes the function. Per chat: 20 updates/min and 300/day (groups 10/min, 200/day), 5 check-ins
  and 10 reports per Singapore day.
- **What it does (v1):** `/start`, location → top 3 (calm) or closest (`/go`, urgent for 2 min),
  typed place → OneMap search → top 3, `/toilet <place>` (alias `/near`, works in groups),
  `/filters`, check-in and status report buttons (anonymous under `hashTelegramId(chatId)` until
  linked), `/privacy`, `/stop` (deletes the chat row), `/unlink`. Results are a list with one
  button per toilet; tapping one opens a card with Navigate / Details / I'm here / Report, and
  check-ins, reports and filters edit the message in place. Account linking: `/me`
  "Connect Telegram" → `POST /me/telegram/link-token` → `https://t.me/<bot>?start=link_<token>`.
- **Stored:** one `TelegramChat` row per chat (chat id, type, pending urgent mode, saved filters,
  linked user id, timestamps). Never names, usernames, phone numbers, message text or coordinates.

### Run it locally (long polling, no tunnel)

1. Create a **separate dev bot** with BotFather (`/newbot`) so local polling never touches the
   production webhook. Put its token in `.env` as `TELEGRAM_BOT_TOKEN` and its username in
   `TELEGRAM_BOT_USERNAME`.
2. `pnpm cli telegram:poll`. It builds once (Nest needs decorator metadata, which `tsx` does not
   emit) and runs `node dist/cli.js telegram:poll`: the same handlers as the webhook, under long
   polling. It refuses to start while the bot has a webhook (polling would delete it) unless you
   pass `--force`. Ctrl+C stops it.
3. Message the dev bot: `/start`, then send a location (Telegram on a phone) or type a place.

### Webhook setup (production)

After the API is deployed with `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and
`TELEGRAM_BOT_USERNAME` set, run once with the production values in your shell env (never paste
them into chat):

```bash
pnpm cli telegram:setup --url https://<api origin>
```

This calls `setWebhook` for `<api origin>/integrations/telegram` with the secret token and the
allowed updates (`message`, `callback_query`, `my_chat_member`), then `setMyCommands` (private
and group lists), `setMyDescription` and `setMyShortDescription`. Without `--url` the webhook goes
to `${PUBLIC_APP_URL}/api/integrations/telegram` (through the frontend's `/api` rewrite); pointing
it at the API origin directly saves a hop. `--drop-pending` discards queued updates;
`--delete` removes the webhook (e.g. before polling with the production bot). Re-run it whenever the
API origin or the secret changes. BotFather: keep `/setprivacy` **Enabled** and `/setjoingroups`
**Enabled**.

## Deployment

The API is its own Vercel project. Full ordered checklist: [`../DEPLOY.md`](../DEPLOY.md).

### Vercel project (API)

- Import this repo; framework preset **NestJS**; root directory `/`.
- `vercel.json` pins `regions: ["sin1"]`, `installCommand: pnpm install --frozen-lockfile` and
  `buildCommand: pnpm vercel-build` (generate, migrate deploy, build, badge sync; the database steps
  are skipped on a Preview deployment without `PREVIEW_DB=1`, see `scripts/vercel-migrate.mjs`).
- Badge rows are synced at build time, not at boot: on Vercel (`VERCEL`/`VERCEL_ENV` set) a cold start
  runs no database query, so an uptime probe on `/health/live` never wakes Neon. Locally, in CI and
  in e2e the app still syncs badges when it starts.
- Vercel's NestJS builder compiles `src/main.ts` itself and turns the whole app into one
  Fluid-compute function. The entry file must contain a literal `@nestjs/core` import for
  detection to work.
  The `dist/` output of `nest build` is not what gets deployed; the build step still runs it as a
  compile gate.
- `package.json` must declare `"packageManager": "pnpm@12.14.0"`; without it Vercel guesses
  pnpm 9 from the lockfile.
- Settings -> Functions -> Default Max Duration: **30 s** (Hobby default is 300 s; nothing here
  needs more, and a low cap stops a hung request from burning compute). This cannot go in
  `vercel.json`: a `functions` entry for `src/main.ts` fails the build with "doesn't match any
  Serverless Functions". Node.js version: 24.x.
- Env vars per environment:
  - **Production**: everything in the table above with production values; `DATABASE_URL` /
    `DIRECT_URL` from the Neon `main` branch.
  - **Preview**: same, except the database. **A Preview scope should not hold the production
    `DATABASE_URL` / `DIRECT_URL`**: an unmerged PR's preview would then read and write production.
    Migrations and the badge sync are the one guarded part: `scripts/vercel-migrate.mjs` skips both
    on a Preview deployment unless `PREVIEW_DB=1` is set for that git branch, which `preview-db.yml`
    does after creating the PR's own Neon branch and writing branch-scoped `DATABASE_URL` /
    `DIRECT_URL` (needs `VERCEL_TOKEN`). Neon's Vercel integration can do the same with a per-branch
    `DATABASE_URL` + `DATABASE_URL_UNPOOLED`; set `PREVIEW_DB=1` project-wide in that case. Also set
    `PUBLIC_APP_URL` / `FRONTEND_ORIGIN`
    to the frontend preview alias if you want them right. Google login only works on origins
    registered in the OAuth client, so use production for login testing.
- Deployment protection: Hobby protects preview URLs with Vercel Authentication. The frontend's
  server-side rewrite cannot log in, so point the frontend's Preview `API_ORIGIN` at the API
  production URL, or disable protection on the API project's previews. Check that the production
  URL (`<api>/health`) answers without a login page, because cron, Telegram and the frontend rewrite
  all call it anonymously.
- Hobby plan: personal, **non-commercial** use only (Vercel's fair-use terms; ads, sponsorship or a
  paid product make it commercial, which needs Pro), a single seat, runtime logs kept for about an
  hour, and hard monthly allowances (function time, invocations, bandwidth) that pause the project
  rather than bill. Confirm the plan against <https://vercel.com/pricing> and
  <https://vercel.com/docs/limits> before launch.
- Regions line up: Vercel `sin1` (both projects), Neon `ap-southeast-1`, R2 location hint APAC.

### Neon

- Project in **AWS ap-southeast-1**, database `sgw`, owner role `neondb_owner`.
- Pooled connection string (`-pooler` host) -> `DATABASE_URL`; direct -> `DIRECT_URL`.
- Branch per PR: install the **Neon Vercel integration** on the API project (recommended), or use
  the fallback `.github/workflows/preview-db.yml` (`preview/pr-<n>` branches, created and migrated
  on PR open/sync, deleted on close).

### Cloudflare R2

1. Photo bucket (e.g. `sgw-photos`, location hint APAC), **private**: no `r2.dev` subdomain and no
   custom domain under Settings -> Public access.
   - Nothing in the bucket has a public URL. Every `PhotoRef.url`/`thumbUrl` is an API path,
     `/api/media/photos/<id>` and `/api/media/photos/<id>/thumb`, through the frontend's `/api`
     rewrite. That route checks who may see the photo (approved: anyone; not yet approved: the
     uploader, TRUSTED+, and signed-in reviewers of an open submission; raw `tmp/` uploads: nobody)
     and answers 302 to a presigned GET on the S3 endpoint (`<account>.r2.cloudflarestorage.com`).
     Approved photos are signed for a fixed one-hour window (valid two hours) and the redirect is
     `public, max-age=<rest of the window>`, so browsers and the CDN cache it; unapproved ones get a
     5-minute window and `private, no-store`. See `src/media/photo-urls.ts`.
   - Local dev without S3 (`LocalStorage`, files under `uploads/`) uses the same route and access
     rules; it streams the file instead of redirecting.
   - Object lifecycle rule: prefix `tmp/`, delete objects 7 days after upload.
   - CORS policy (presigned PUT from the browser):
     ```json
     [
       {
         "AllowedOrigins": ["https://shitgowhere.com", "https://<frontend>.vercel.app", "http://localhost:3000"],
         "AllowedMethods": ["PUT", "GET", "HEAD"],
         "AllowedHeaders": ["content-type", "content-length"],
         "ExposeHeaders": ["ETag"],
         "MaxAgeSeconds": 3600
       }
     ]
     ```
     The browser PUTs straight to R2 from the **site's origin**, so the production domain must be in
     `AllowedOrigins` (add `https://www.` too if it serves content instead of redirecting). Without
     it, every photo upload fails in the browser while the API looks healthy. Photo reads are plain
     `<img>` loads that follow a redirect, which needs no CORS.
   - Moving an existing public bucket to private: deploy this code first and check photos load (their
     URLs are `/api/media/photos/...` now; existing rows need no migration, the URLs are derived from
     the photo id). Only then turn off Public access (disable `r2.dev`, disconnect the custom domain),
     purge that domain's Cloudflare cache, and remove `S3_PUBLIC_URL` from Vercel (it is ignored).
   - The `tmp/` lifecycle rule is the only cleanup of abandoned uploads (the app removes `tmp/`
     objects it confirms or rejects, nothing else). Rows in `Photo` with `confirmed = false` are not
     purged by any job.
2. Backup bucket (e.g. `sgw-backups`), **private** (no public access). Optionally add a lifecycle
   rule deleting `db/` objects after 35 days as a backstop to the workflow's 30-day cleanup.
3. API tokens (R2 -> Manage API tokens): one *Object Read & Write* token scoped to the photo
   bucket (`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`), and a separate one scoped to the backup
   bucket for GitHub Actions.

### Google OAuth

Google Cloud console -> APIs & Services -> Credentials -> OAuth client ID (Web application).
Consent screen: external, scopes `openid email profile`.

- Authorised JavaScript origins: `https://<frontend>.vercel.app`, `http://localhost:3000`
- Authorised redirect URIs: `https://<frontend>.vercel.app/api/auth/callback`,
  `http://localhost:3000/api/auth/callback`

The redirect goes through the **frontend** origin (Next rewrites `/api/*` to this API), which is
what keeps the session cookie first-party.

Before launch, with the real domain: add `https://shitgowhere.com` and
`https://shitgowhere.com/api/auth/callback` to the client, set `PUBLIC_APP_URL` to the same origin
(a mismatch gives `redirect_uri_mismatch`), and **publish the consent screen**. Check:
Google Cloud console -> Google Auth Platform (older UI: APIs & Services -> OAuth consent screen) ->
Audience / Publishing status must read *In production*. In *Testing* only listed test users (max 100)
can sign in. With only the `openid email profile` scopes no Google verification review is needed, but
the app name, logo, support email, homepage and privacy-policy link on the consent screen should
match the site.

### OneMap

Register at <https://www.onemap.gov.sg/apidocs/register>; the email and password go in
`ONEMAP_EMAIL` / `ONEMAP_PASSWORD`. Tokens last 3 days; the API caches the current one in the `KeyValue` table (`onemap:token`), renews it
30 minutes before expiry and retries once on a 401/403. A wrong or expired account is silent to users
(routes fall back to straight-line estimates); look for `OneMap token failed` in the logs.

### GitHub Actions secrets and variables (this repo)

| Name | Kind | Used by |
|---|---|---|
| `DIRECT_URL` | secret | `scheduled.yml` (CLI imports, `pg_dump`) - Neon `main` direct URL |
| `CRON_SECRET` | secret | `scheduled.yml` maintenance calls |
| `R2_BACKUP_ACCESS_KEY_ID` / `R2_BACKUP_SECRET_ACCESS_KEY` | secret | backup upload, download for verification |
| `BACKUP_HEARTBEAT_URL` | secret, optional but recommended | dead-man's-switch URL (healthchecks.io, Better Stack, ...) pinged after every *verified* backup; alerts you when backups stop, including when GitHub disables the schedule |
| `ONEMAP_EMAIL` / `ONEMAP_PASSWORD` | secret, optional | imports that geocode |
| `NEON_API_KEY` | secret | `preview-db.yml` |
| `VERCEL_TOKEN` | secret, optional | `preview-db.yml` without the Neon integration |
| `API_URL` | variable | `scheduled.yml`, e.g. `https://sgw-api.vercel.app` |
| `R2_ACCOUNT_ID` | variable | backup endpoint |
| `R2_BACKUP_BUCKET` | variable | backup bucket name |
| `PG_DUMP_IMAGE` | variable, optional | defaults to `postgres:17-alpine`; must match or exceed Neon's Postgres major |
| `NEON_PROJECT_ID` | variable | `preview-db.yml` |
| `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | variable, optional | `preview-db.yml` without the integration |
| `PREVIEW_SEED` | variable, optional | `true` to seed new preview branches |

### CI (`.github/workflows/ci.yml`)

On every PR and push to `main`: install, lint, typecheck, unit tests, `prisma migrate deploy`
against a `postgres:17-alpine` service, schema drift guard, e2e tests, `pnpm openapi` (uploaded
as the `openapi` artifact). A separate, non-blocking `audit` job runs `pnpm audit --prod`. CI does
**not** gate Vercel: Vercel builds on push regardless (see "Deploy gate"). Actions are pinned to
major tags and kept current by Dependabot (`.github/dependabot.yml`).

### Backups (`scheduled.yml`)

Nightly at 03:00 SGT: `maintenance` (metrics, expire submissions, archive status reports) then
`backup`: `pg_dump --no-owner --no-privileges` of the whole database (plain SQL, so it includes the
`_prisma_migrations` table; no roles, no extensions are needed) -> gzip -> `s3://<bucket>/db/sgw-<UTC stamp>.sql.gz`,
sweep of objects older than 30 days (the newest 7 are always kept), then `verify-backup`: downloads
that object and restores it into a throwaway Postgres (`.github/scripts/verify-restore.sh`), checks
the row counts and pings `BACKUP_HEARTBEAT_URL`. Run `verify-backup` alone from the Actions tab to
check the newest object at any time. To restore for real: [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md) section 6.
GitHub disables scheduled workflows after 60 days without repository activity; the heartbeat is how
you find out (a weekly `keepalive` job and Dependabot PRs make it unlikely).

### Deploy gate (Vercel `ignoreCommand`)

`vercel.json` runs `.github/scripts/vercel-ignore-build.mjs` before every Git-triggered build:

- **Always on:** a build is skipped when the diff since the last successful build only touches docs,
  CI config or tests. Anything unexpected (no previous build, shallow clone, script error) builds.
- **Opt-in CI gate:** set `SGW_REQUIRE_CI=1` in the project's *Production* environment variables and a
  production build waits (default 10 minutes, `SGW_CI_WAIT_S`) for the commit's GitHub Actions checks,
  cancels the deploy if one failed and builds if none reported in time. `[skip-ci-gate]` in the commit
  message bypasses it for a hotfix. For a private repo also set `GITHUB_TOKEN` (read access to checks).
  Hobby has one concurrent build, so a waiting gate delays the builds behind it. The simplest
  alternative with the same effect for normal flow is branch protection: require the CI check on PRs
  into `main` and only merge through PRs.

### Observability

What exists: Vercel runtime logs (about one hour on Hobby; production logs only `error` and `warn`,
not Nest's route table), Sentry error tracking, two health routes, PostHog events from the API, the
nightly workflow results. What does not: an uptime monitor and alerts (set them up, below).

**Health routes**

- `GET /health/live`: liveness. Never touches the database and is not rate-limited; returns
  `{ ok, commit, time }` where `commit` is the deployed `VERCEL_GIT_COMMIT_SHA` (answers "is this the
  SHA I just deployed?"). Point the uptime monitor here: `<site>/api/health/live` and `<site>/`,
  5-minute interval, alert on two consecutive failures. On Vercel a cold start opens no database
  connection at all (badges are synced by the build, the pg pool connects lazily), so this probe lets
  Neon scale to zero.
- `GET /health`: readiness, runs `SELECT 1`. 503 `{ ok: false, db: 'down' }` when Neon is unreachable.
  Use it by hand or in a slow (15-30 minute) probe: every call wakes Neon's compute.

**Sentry** (`@sentry/nestjs`, `src/instrument.ts`, `src/observability/`). Initialised only when
`SENTRY_DSN` is set; local dev, tests, `pnpm openapi` and the CLI send nothing.

- What is reported: unhandled errors and 5xx responses (including `/health`'s 503 when the database
  is down). 4xx `HttpException`s (validation, 401/403/404, 429) are not.
- Tagged with `environment = VERCEL_ENV` (`production` / `preview`) and `release = VERCEL_GIT_COMMIT_SHA`.
- Privacy (PDPA): SDK `dataCollection` turns off user info, cookies, bodies, query parameters and
  local variables, and `beforeSend` scrubs again: request cookies, body and query string removed, only
  `user-agent`, `content-type`, `content-length`, `accept` and `x-vercel-id` headers kept (no
  `authorization`, `cookie`, `x-sgw-*`, `x-forwarded-for`), `user.ip_address` pinned to null, and query
  strings stripped from breadcrumb URLs (OneMap calls carry coordinates).
- Quota: errors only. Tracing and profiling are off (`tracesSampleRate` unset, so no spans are even
  created; `SENTRY_TRACES_SAMPLE_RATE` would opt in, so leave it unset). Outgoing calls get no
  `sentry-trace`/`baggage` headers.
- Serverless: the global filter calls `waitUntil(Sentry.flush())` after each report, so the event
  leaves before Vercel freezes the function (the SDK also flushes after each response on Vercel).
- In the Sentry project: create an alert rule (new issue, and regression) to an email or channel you
  read, and enable *Settings > Security & Privacy > Prevent Storing of IP Addresses* as a backstop.

`docs/probe-production.sh` records headers, redirects and latency spread of the live site.

## Accounts you must create

- [ ] GitHub org/repos (public, for unlimited Actions minutes)
- [ ] Vercel (Hobby) - two projects: API and frontend
- [ ] Neon - project in `ap-southeast-1`, API key for previews
- [ ] Cloudflare - R2 enabled, photo + backup buckets, two API tokens
- [ ] Google Cloud - OAuth consent screen + web client
- [ ] OneMap - developer account
- [ ] Telegram - bot via BotFather (plus a separate dev bot for local polling)
- [ ] Sentry - org `shit-go-where`, one project per app (`sgw-backend` for this API, US region)
