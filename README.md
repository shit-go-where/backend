# Shit Go Where API

NestJS 12 (ESM) + Prisma 7 + PostgreSQL backend for **Shit Go Where**, a Singapore public toilet
finder: find, rate, contribute and route to toilets. It owns the database, Google auth, imports,
moderation and gamification. The frontend (separate repo) reaches it through a Next.js `/api/*`
rewrite, so in production the browser never talks to this service directly.

Design and roadmap: [`../PLAN.md`](../PLAN.md). Endpoint contract: [`API_CONTRACT.md`](API_CONTRACT.md).
First production deploy: [`../DEPLOY.md`](../DEPLOY.md).

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
- Health: <http://localhost:4000/health>
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
| `pnpm db:seed` | `prisma db seed` (`tsx prisma/seed.ts`) |
| `pnpm db:reset` | Drop, re-migrate and re-seed the local DB |
| `pnpm cli <command>` | Data pipeline, see below |
| `pnpm vercel-build` | Vercel build: `prisma generate && prisma migrate deploy && nest build` |

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
| `import:osm` | Import / refresh OpenStreetMap toilets (ODbL, attributed) |
| `import:datagov --dataset <name\|all>` | Import data.gov.sg datasets (hawker centres, CCs, parks ...) |
| `import:wikidata` | Import MRT/LRT stations from Wikidata |
| `recompute-scores` | Recompute toilet scores and rankings |
| `all` | Run the whole first-cut pipeline in order |

Scheduled runs (GitHub Actions, `.github/workflows/scheduled.yml`): weekly `import:osm` +
`recompute-scores`; monthly `import:datagov --dataset all` + `import:wikidata`; nightly
maintenance endpoints and a database backup. Any job can be started by hand from the Actions tab
(**Scheduled** -> Run workflow -> pick a job).

## Environment variables

Validated at boot by `src/config/env.ts`; the app refuses to start on invalid config.

| Variable | Required | Local default | Production value |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgresql://sgw:sgw@localhost:5433/sgw` | Neon **pooled** URL (`-pooler` host, `?sslmode=require`) |
| `DIRECT_URL` | for migrations/seed/CLI | same as above | Neon **direct** URL (non-pooler host) |
| `PORT` | no | `4000` | not needed on Vercel |
| `NODE_ENV` | no | `development` | Vercel sets `production` |
| `FRONTEND_ORIGIN` | no | `http://localhost:3000` | frontend origin (CORS for Swagger/local tools only) |
| `PUBLIC_APP_URL` | no | `http://localhost:3000` | frontend origin; OAuth redirect is `PUBLIC_APP_URL/api/auth/callback` |
| `AUTH_SECRET` | yes, 16+ chars | `change-me-...` | `openssl rand -base64 48` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Google login | empty | Google OAuth web client |
| `ONEMAP_EMAIL` / `ONEMAP_PASSWORD` | for routing + geocoding | empty | OneMap account |
| `S3_ENDPOINT` | for photos | empty | `https://<account-id>.r2.cloudflarestorage.com` (omit for AWS S3) |
| `S3_REGION` | no | `auto` | `auto` (R2) |
| `S3_BUCKET` | for photos | empty | photo bucket name |
| `S3_PUBLIC_URL` | for photos | empty | bucket public URL (`https://pub-<hash>.r2.dev`) or custom domain |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | for photos | empty | R2 API token scoped to the photo bucket |
| `ADMIN_EMAILS` | no | `you@example.com` | comma-separated; promoted to ADMIN on first login |
| `CRON_SECRET` | for `/admin/jobs/*` | `change-me` | random; same value as the GitHub secret |
| `DEV_LOGIN_ENABLED` | no | `true` | **unset** (boot fails if `true` in production) |
| `SENTRY_DSN` | no | empty | optional |
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
  linked), `/privacy`, `/stop` (deletes the chat row), `/unlink`. Account linking: `/me`
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
  `buildCommand: pnpm vercel-build` (generate, migrate deploy, build).
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
  - **Preview**: same, except the database (Neon's Vercel integration injects a per-branch
    `DATABASE_URL` + `DATABASE_URL_UNPOOLED`; without the integration, `preview-db.yml` writes
    branch-scoped `DATABASE_URL` / `DIRECT_URL`), and `PUBLIC_APP_URL` / `FRONTEND_ORIGIN` set
    to the frontend preview alias if you want them right. Google login only works on origins
    registered in the OAuth client, so use production for login testing.
- Deployment protection: Hobby protects preview URLs with Vercel Authentication. The frontend's
  server-side rewrite cannot log in, so point the frontend's Preview `API_ORIGIN` at the API
  production URL, or disable protection on the API project's previews.

### Neon

- Project in **AWS ap-southeast-1**, database `sgw`, owner role `neondb_owner`.
- Pooled connection string (`-pooler` host) -> `DATABASE_URL`; direct -> `DIRECT_URL`.
- Branch per PR: install the **Neon Vercel integration** on the API project (recommended), or use
  the fallback `.github/workflows/preview-db.yml` (`preview/pr-<n>` branches, created and migrated
  on PR open/sync, deleted on close).

### Cloudflare R2

1. Photo bucket (e.g. `sgw-photos`, location hint APAC).
   - Settings -> Public access -> enable the `r2.dev` subdomain (or connect a custom domain);
     its URL is `S3_PUBLIC_URL`.
   - Object lifecycle rule: prefix `tmp/`, delete objects 7 days after upload.
   - CORS policy (presigned PUT from the browser):
     ```json
     [
       {
         "AllowedOrigins": ["https://<frontend>.vercel.app", "http://localhost:3000"],
         "AllowedMethods": ["PUT", "GET", "HEAD"],
         "AllowedHeaders": ["content-type", "content-length"],
         "ExposeHeaders": ["ETag"],
         "MaxAgeSeconds": 3600
       }
     ]
     ```
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

### OneMap

Register at <https://www.onemap.gov.sg/apidocs/register>; the email and password go in
`ONEMAP_EMAIL` / `ONEMAP_PASSWORD`. Tokens last 3 days and are refreshed and cached by the API.

### GitHub Actions secrets and variables (this repo)

| Name | Kind | Used by |
|---|---|---|
| `DIRECT_URL` | secret | `scheduled.yml` (CLI imports, `pg_dump`) - Neon `main` direct URL |
| `CRON_SECRET` | secret | `scheduled.yml` maintenance calls |
| `R2_BACKUP_ACCESS_KEY_ID` / `R2_BACKUP_SECRET_ACCESS_KEY` | secret | backup upload |
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
as the `openapi` artifact).

## Accounts you must create

- [ ] GitHub org/repos (public, for unlimited Actions minutes)
- [ ] Vercel (Hobby) - two projects: API and frontend
- [ ] Neon - project in `ap-southeast-1`, API key for previews
- [ ] Cloudflare - R2 enabled, photo + backup buckets, two API tokens
- [ ] Google Cloud - OAuth consent screen + web client
- [ ] OneMap - developer account
- [ ] Telegram - bot via BotFather (plus a separate dev bot for local polling)
- [ ] Sentry (optional) - one project per app
