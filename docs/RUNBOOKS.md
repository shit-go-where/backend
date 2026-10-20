# Operations runbooks

One page each. Written for a single on-call person (the owner) at 2 a.m. with a phone and a
laptop. Everything here was checked against the code in this repo; where a step depends on a
dashboard that can change, it says so. Placeholders: `<api>` is the API's production URL,
`<site>` is `https://shitgowhere.com`.

| # | Runbook | Use it when |
|---|---|---|
| 1 | [Incident triage](#1-incident-triage) | Anything looks broken |
| 2 | [Roll back a deploy](#2-roll-back-a-deploy) | A release made things worse |
| 3 | [Migration succeeded, build failed (forward-fix)](#3-the-migration-ran-but-the-deploy-failed-forward-fix) | Deploy is red and the schema may be ahead of the live code |
| 4 | [Rotate `AUTH_SECRET`](#4-rotate-auth_secret) | Secret leaked, or a scheduled rotation |
| 5 | [Rotate the Telegram secret](#5-rotate-the-telegram-webhook-secret) | Webhook secret or bot token leaked |
| 6 | [Restore a backup](#6-restore-a-backup) | Data lost or corrupted |
| 7 | [Take down a photo](#7-take-down-a-photo) | Report of an illegal, private or abusive photo |
| 8 | [Ban a user](#8-ban-a-user) | Abuse, spam, leaderboard cheating |
| 9 | [Pause the bot](#9-pause-the-bot) | The Telegram bot misbehaves or is being abused |
| 10 | [Routine secrets and expiring things](#10-routine-secrets-and-expiring-things) | Calendar reminders |

## How the pieces fit (read once)

```
phone ──https──> Vercel project "frontend" (Next.js, sin1)
                    │  /api/*  rewrite (server side)        /ingest/* ──> PostHog EU
                    ▼
                 Vercel project "api" (NestJS, one Fluid function, sin1) ──> OneMap, Telegram API
                    │ DATABASE_URL (Neon pooler)                         ──> R2 (photos, presigned PUT from the browser)
                    ▼
                 Neon Postgres (ap-southeast-1)

GitHub Actions (scheduled.yml): nightly maintenance jobs + pg_dump to R2 (private bucket), weekly OSM
import, monthly imports. Telegram calls the API directly: <api>/integrations/telegram.
```

- The browser only ever talks to `<site>`. The API's public URL also works from anywhere, which is
  how cron, Telegram and the health checks reach it.
- Sessions are stateless signed cookies (30 days). Roles are re-read from the database on every
  request, so promoting, demoting or deleting a user takes effect immediately.
- Hobby plan consequences that matter at 2 a.m.: **runtime logs are kept for about an hour only**,
  there is one seat (you), and exceeding the monthly allowance pauses the project instead of billing
  (check <https://vercel.com/docs/limits> for the current numbers).
- Every `pnpm cli ...` command loads `backend/.env` through `dotenv`; variables already exported in
  your shell win. Before running anything against production, export production values explicitly
  and prove where you are pointing: `psql "$DIRECT_URL" -Atc "select current_database(), inet_server_addr()"`.

---

## 1. Incident triage

**Goal: in five minutes know which layer is broken, and whether a rollback fixes it.**

1. **Is it really down?** Open `<site>/api/health` on mobile data (not wifi).
   - `{"ok":true,"db":"up",...}`: the whole chain works. The problem is narrower (one route, one
     feature, one user). Go to step 5.
   - `503 {"ok":false,"db":"down"}`: the API is up, the database is not reachable. Step 4.
   - A Vercel error page, 5xx without that JSON, or a timeout: step 2.
2. **Frontend or API?** Open `<api>/health` directly. If this works but `<site>/api/health` does not,
   the frontend project or its `API_ORIGIN` is wrong (check Settings -> Environment Variables on the
   frontend project; the value must be the API's production URL, no trailing slash). If both fail,
   the API project is the problem.
3. **Platforms.** Check <https://www.vercel-status.com>, <https://neonstatus.com>,
   <https://www.cloudflarestatus.com>, <https://www.githubstatus.com>. A platform incident means
   wait, tell users, do not roll back.
4. **Database.** Neon console -> project -> Monitoring: connections, CPU, storage. Typical causes:
   - Compute was suspended and is waking: the first request after idle is slow (hundreds of ms to a
     few seconds), then normal. Not an outage.
   - Free-tier compute allowance or storage exhausted: the console says so; upgrade or wait.
   - Too many connections: each API instance opens up to 10 pooled connections (`pg` default).
     Confirm `DATABASE_URL` uses the `-pooler` host; if it does not, fix it (Vercel -> API ->
     Environment Variables -> redeploy).
5. **Logs, fast.** Vercel -> API project -> Logs, filter "Error"/status 5xx, last hour. Hobby drops
   older logs, so copy what you need into the incident notes now. CLI: `vercel logs <deployment-url>`
   streams live. Nest logs unhandled errors with a stack trace.
6. **Did a deploy just happen?** Vercel -> Deployments. If the first bad request is after a deploy,
   roll back ([runbook 2](#2-roll-back-a-deploy)) before debugging.
7. **Known degradations that are not incidents:**
   - OneMap down or credentials rejected: routes fall back to straight-line walking estimates
     (`OneMapService.walk` returns null); the warning is in the logs ("OneMap token failed"). Search
     returns an empty list.
   - R2 down: photo upload and confirm fail; everything else works.
   - API down: the service worker serves the last saved nearby list ("saved from where you were"),
     so people with the app installed still see something.
   - Telegram updates failing: bot only. [Runbook 9](#9-pause-the-bot).
8. **Scheduled jobs.** GitHub -> backend repo -> Actions -> Scheduled. A red nightly run means the
   maintenance endpoints or the backup failed; the backup heartbeat email (if you set
   `BACKUP_HEARTBEAT_URL`) is the early warning.
9. **Write down** what you saw, what you changed and when. Hobby logs will not remember it for you.

---

## 2. Roll back a deploy

Vercel keeps every deployment, so a rollback is a pointer change. Do the API and the frontend
independently, because they are separate projects.

**Dashboard (works from a phone):** Project -> Deployments -> pick the last good *Production*
deployment -> `...` -> **Instant Rollback** (also called Promote on older deployments). On Hobby you
may only be offered the previous production deployment; if you need an older one, redeploy that
commit instead (step 3). Confirm: `<api>/health` and `<site>/` respond, and the `sw.js`
build id (`curl -s <site>/sw.js | grep '^const BUILD'`, the deployment id) is the old one.

**CLI:** `vercel rollback <deployment-url> --scope <team>` (per project directory).

**After a rollback:**

- Vercel turns off auto-assignment of the production domain, so the next `git push` to `main` will
  *not* go live by itself. Re-enable it in Project -> Settings -> Domains (or promote the fix
  deployment) once the fix is ready. Check this; the exact wording moves between dashboard versions.
- Environment variable changes apply only to *new* deployments. A rollback restores the old code
  *and* the env it was built with.
- **The database is not rolled back.** See [runbook 3](#3-the-migration-ran-but-the-deploy-failed-forward-fix).
  Old code runs against the new schema. That is safe for additive migrations (new tables, nullable
  columns, new indexes). It is **not** safe past `20261019120000_community_loop`, which made
  `CheckIn.userId` and `StatusReport.userId` nullable (anonymous contributions): code from before
  that migration can crash on rows with a null user. It also added enum values
  (`PointReason`, `SubmissionState`) that older code does not know. Never roll back past it.
- If the frontend was the broken side and the API contract changed in the same release, roll back
  the frontend first, then the API only if still needed (the API ships first by convention, so a
  newer API with an older frontend is the supported direction).
- Redeploying an old commit (instead of Instant Rollback) re-runs `pnpm vercel-build`, which runs
  `prisma migrate deploy`. Old commits contain only old migrations, so it is a no-op, but it needs
  `DIRECT_URL` reachable.

**CI gate bypass:** if `SGW_REQUIRE_CI=1` is set and `main` is red, production builds are cancelled.
To ship a hotfix anyway, put `[skip-ci-gate]` in the commit message (see README, "Deploy gate").

---

## 3. The migration ran but the deploy failed (forward-fix)

`pnpm vercel-build` is `prisma generate && prisma migrate deploy && nest build`. The migration is
applied to the database *before* the app compiles. If `nest build` (or anything later) fails, Vercel
keeps serving the previous deployment, now against the **new schema**. Nothing is half-applied
inside the migration itself (each migration runs in a transaction, except statements Postgres
cannot run in one), but the database is ahead of the code.

1. **Don't panic and don't touch the migration.** The previous deployment keeps working as long as
   the migration was additive. Check: `<api>/health` and one real read (`<site>/api/toilets/nearby?lat=1.2993&lng=103.8455`).
2. **Find out what ran.**
   ```bash
   export DIRECT_URL='postgresql://...'        # Neon direct (non-pooler) URL, production
   pnpm prisma migrate status                  # lists applied and pending migrations
   psql "$DIRECT_URL" -c 'select migration_name, finished_at, rolled_back_at from _prisma_migrations order by started_at desc limit 5'
   ```
3. **Fix forward**, never edit or delete the applied migration (README, "Migration rules"):
   - Build failed for a code reason: fix the code, push. The new build's `migrate deploy` finds the
     migration already applied and skips it.
   - The migration itself was wrong: add a *new* migration that corrects it
     (`pnpm db:migrate --name fix_<thing>` locally, review the SQL, commit, push).
   - A migration failed half way (`finished_at` is null in `_prisma_migrations`; the next build fails
     with `P3009`): inspect what it did, repair by hand if needed, then tell Prisma:
     `pnpm prisma migrate resolve --rolled-back <name>` (it will be retried on the next deploy) or
     `--applied <name>` (you completed it manually). Take a manual backup first (runbook 6, "Dump now").
4. **Two builds at once** (two pushes in a row): Prisma holds an advisory lock while migrating, and a
   second build that cannot get it within about 10 seconds fails with `P1002`. Redeploy it from the
   dashboard when the first one finishes.
5. **Never point a Preview deployment at the production database.** A preview build also runs
   `migrate deploy`; with production `DIRECT_URL` in the Preview scope, an unmerged PR would migrate
   production. Preview `DATABASE_URL`/`DIRECT_URL` must be a Neon branch (Neon's Vercel integration, or
   `preview-db.yml`). Check Vercel -> API -> Settings -> Environment Variables: no variable named
   `DATABASE_URL`, `DIRECT_URL` or `DATABASE_URL_UNPOOLED` should be ticked for *Preview* with the
   production value.
6. **Prevent it:** keep migrations additive (expand, deploy, then contract in a later release);
   CI already fails when `schema.prisma` and the migrations disagree.

---

## 4. Rotate `AUTH_SECRET`

`AUTH_SECRET` signs three things, so rotating it has three visible effects:

| Signed with it | Effect of rotating |
|---|---|
| `sgw_session` cookie (30 days) | **Everyone is signed out.** There is no other way to revoke sessions. |
| `sgw_anon` device cookie (365 days) | Anonymous visitors get a new device id. Check-ins and status reports banked under the old id can no longer be merged into an account on sign-in. |
| Telegram chat hash (`hashTelegramId`, the `deviceId` of unlinked chats) | Unlinked chats get a new pseudonymous id: their banked points can no longer be linked, and their daily caps restart. Linked chats are unaffected (they use the user id). |
| Google OAuth `state` | Logins in flight during the swap fail once; retry. |

Do it when the secret is suspected leaked (an attacker can forge a session for any user id,
including an ADMIN's, with it) or on a yearly schedule. Prefer a quiet hour.

1. Generate: `openssl rand -base64 48`.
2. Vercel -> **API** project -> Settings -> Environment Variables -> edit `AUTH_SECRET` (Production).
   The frontend does not know this secret.
3. **Redeploy production** (Deployments -> latest -> Redeploy). Env changes do not touch running
   deployments. The deploy is the cut-over: from the moment it is live, old cookies are rejected.
4. GitHub Actions does not need it (`scheduled.yml` uses a placeholder for the CLI).
5. Verify: your own session is gone (`<site>/me` asks to sign in), sign in again, `<api>/health` ok.
6. If it was a leak: also rotate `CRON_SECRET`, check `User` rows with `role >= MODERATOR`
   (`select id,email,role from "User" where role <> 'USER'`) and review recent admin actions.
7. Tell users nothing; sign-out is silent. Expect a small dip in check-ins that day.

---

## 5. Rotate the Telegram webhook secret

The webhook secret is checked on every update (`X-Telegram-Bot-Api-Secret-Token`). Telegram only
learns the new value when you call `setWebhook` again, so the API and Telegram must change together.
There is no overlap window: between redeploy and `telegram:setup`, updates are answered `401` and
Telegram retries them for a while, so keep the gap to a couple of minutes.

1. Generate: `openssl rand -hex 32`.
2. Vercel -> **API** -> Environment Variables -> `TELEGRAM_WEBHOOK_SECRET` (Production) = new value.
3. Redeploy production and wait until it is live.
4. Immediately, from a shell with production values (`TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`; `DATABASE_URL` and `AUTH_SECRET` only need to
   satisfy validation for this command):
   ```bash
   pnpm cli telegram:setup --url https://<api>      # prints "webhook -> https://<api>/integrations/telegram"
   ```
   It also prints `pending updates: N` and `last error:` if Telegram was getting 401s.
5. Verify: send the bot `/start` from your phone; `pending updates` is 0 after a minute.
   `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"` shows the URL and no
   `last_error_message`.

**If the bot token itself leaked:** BotFather -> `/revoke` (pick the bot) gives a new token and kills
the old one at once. Update `TELEGRAM_BOT_TOKEN` in Vercel, redeploy, then run step 4. Also rotate the
webhook secret, since the old token holder could have read it with `getWebhookInfo`.

Notes: `--drop-pending` discards queued updates (use it only if the queue is stale junk). The
webhook returns 503 while `TELEGRAM_WEBHOOK_SECRET` is unset, so a missing env var fails closed.

---

## 6. Restore a backup

**What you have**

| Source | Granularity | Where |
|---|---|---|
| Neon point-in-time restore | to the second, within the plan's history window (short on the free plan; check Neon -> Settings -> Storage/History) | Neon console -> Branches -> Restore |
| Nightly `pg_dump` | once a day at about 03:00 Singapore time (19:00 UTC), kept 30 days (never fewer than 7) | R2 bucket `R2_BACKUP_BUCKET`, objects `db/sgw-<UTC stamp>.sql.gz` |

The dump is plain SQL, taken with `--no-owner --no-privileges`, of one database: schema, data, and
the `_prisma_migrations` table (so Prisma knows the schema is current after a restore). It contains
no roles or grants (Neon manages roles; the restoring role owns the objects) and the schema uses no
extensions. Lost between dump and incident: up to 24 hours of contributions. Photos in R2 are not part
of the backup (the bucket is the storage); a restored database may point at photos that exist and
miss rows for photos uploaded later (orphans, harmless).

`scheduled.yml` restores every night's dump into a throwaway Postgres and counts rows
(`verify-backup` job), so "the backup exists" has been proven to mean "the backup restores".

**Decide first**

- *A bad write or deletion in the last few hours:* use Neon point-in-time restore (A). It is the
  fastest and loses nothing.
- *Older than the history window, a dropped project, or Neon is the problem:* restore the dump (B).

### A. Point-in-time restore (Neon)

1. Neon console -> project -> Branches -> `main` -> **Restore**, choose the time just before the
   incident, and keep the "backup of the current state" branch it offers (it preserves what you are
   about to overwrite).
2. The connection strings and database name do not change; no env change, no redeploy. Reconnect
   happens by itself (the pooler reopens connections).
3. Verify as in B, step 6.

### B. Restore the nightly dump into a new database, then cut over

1. **Fetch the dump.** You need an R2 API token with read access to the backup bucket (the same one
   as the `R2_BACKUP_*` GitHub secrets):
   ```bash
   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=auto
   export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
   EP=https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
   aws s3 ls s3://<bucket>/db/ --endpoint-url $EP | tail -5        # newest last
   aws s3 cp s3://<bucket>/db/sgw-<stamp>.sql.gz . --endpoint-url $EP
   gzip -t sgw-<stamp>.sql.gz && gzip -dc sgw-<stamp>.sql.gz | tail -n 3   # "dump complete" = whole file
   ```
2. **Dump the broken database first** (so you can compare or salvage):
   ```bash
   docker run --rm -e PGURL="$DIRECT_URL" postgres:17-alpine sh -c 'pg_dump --no-owner --no-privileges --dbname="$PGURL"' | gzip -9 > broken-$(date -u +%Y%m%dT%H%MZ).sql.gz
   ```
3. **Create the target.** Same Neon project, new empty database, so nothing is overwritten:
   ```bash
   psql "$DIRECT_URL" -c 'CREATE DATABASE sgw_restore'
   export RESTORE_URL="${DIRECT_URL%/*}/sgw_restore?sslmode=require"   # same host, new database name
   ```
   (If the whole project is gone, create a new Neon project in AWS ap-southeast-1 instead and use its
   direct URL; every connection string then changes in step 7.)
4. **Load the dump.** Use the `postgres` client image that matches the dump, not an older `psql`:
   the dump starts with `\restrict` lines that older `psql` builds reject, and the Neon SQL editor
   cannot run a file this size.
   ```bash
   gzip -dc sgw-<stamp>.sql.gz | docker run -i --rm -e PGURL="$RESTORE_URL" postgres:17-alpine \
     sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 -q -1'
   ```
   `-1` runs it as one transaction: any error leaves the new database empty rather than half full.
   Restoring into a non-empty database fails on the first `CREATE TYPE`; that is why step 3 makes a
   new one. No `--clean` is needed.
5. **Check it.**
   ```bash
   psql "$RESTORE_URL" -Atc 'select count(*) from "Toilet"' -c 'select count(*) from "Venue"' \
     -c 'select count(*) from "User"' -c 'select count(*) from _prisma_migrations where finished_at is not null'
   DIRECT_URL="$RESTORE_URL" pnpm prisma migrate status          # "Database schema is up to date!"
   DIRECT_URL="$RESTORE_URL" pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code   # exit 0
   ```
   (Run the two `prisma` commands from the commit that is deployed.)
6. **Boot the API against it** before cutting over: locally
   `DATABASE_URL="$RESTORE_URL" DIRECT_URL="$RESTORE_URL" NODE_ENV=production AUTH_SECRET=<16+ chars> pnpm build && node dist/main.js`
   then `curl localhost:4000/health` and `curl 'localhost:4000/toilets/nearby?lat=1.2993&lng=103.8455'`.
7. **Cut over.** Vercel -> API -> Environment Variables (Production): set `DIRECT_URL` to
   `$RESTORE_URL`, and `DATABASE_URL` to the same host's **pooler** URL with `/sgw_restore` as the
   database. Redeploy production. Update the GitHub secret `DIRECT_URL` (backend repo -> Settings ->
   Secrets) so tonight's backup and the imports use the new database. Keep the old database until the
   incident is closed, then `DROP DATABASE`.
8. **Afterwards:** `pnpm cli recompute-scores` if scores look stale; accounts created after the dump
   are gone (their cookies are valid but resolve to no user, so those people simply appear signed out
   and sign in again, getting a fresh account); run the `maintenance` job once from the Actions tab.

**Timing to expect.** On a laptop, dumping and restoring the seeded 11 MB database (1,096 toilets,
1,436 venues) takes well under a second each; the compressed dump is about 200 KB. Production will
be a few MB. Budget 15 minutes for the whole of B, most of it clicking. Neon-side timings (creating
the database, connection warm-up) are not measured here; time your first drill and write it below.

> Drill log: _date, who, which dump, total minutes, anything surprising_

### Dump now (manual backup before a risky change)

Actions -> Scheduled -> Run workflow -> `backup` (then `verify-backup`), or the `docker run ... pg_dump`
line in step 2 from your laptop.

---

## 7. Take down a photo

Photos are re-encoded server-side (EXIF and GPS stripped) and only become public when approved, so
the takedown case is an *approved* photo (or one still waiting for approval) that must go now.

1. **Find the photo id.** Photo URLs on the site look like `<site>/api/media/photos/<id>` (thumbnail:
   `.../<id>/thumb`). A link someone copied after the redirect is a presigned R2 URL,
   `https://<account>.r2.cloudflarestorage.com/<bucket>/photos/<id>.jpg?X-Amz-...`; the id is the file
   name. Or, from the database:
   ```sql
   select id, url, "toiletId", "uploadedById", approved from "Photo" where url like '%<part of the url>%';
   ```
2. **Delete it through the API** (this removes both R2 objects and the row, for approved photos too):
   - Pending photos: `<site>/admin` -> Photos tab -> Reject.
   - Approved photos have no button. As a MODERATOR or ADMIN, signed in on `<site>`, copy the
     `sgw_session` cookie value from the browser (DevTools -> Application -> Cookies) and:
     ```bash
     curl -i -X POST -H "Cookie: sgw_session=<value>" "<site>/api/admin/photos/<id>/reject"   # 200 {"ok":true}
     ```
3. **Verify it is really gone.** Object deletion is best effort (a failure is only logged, and the
   row is deleted regardless), so check the URL:
   ```bash
   curl -I "<site>/api/media/photos/<id>"   # must be 404
   ```
   If it is still served, delete the object by hand: Cloudflare dashboard -> R2 -> photo bucket ->
   `photos/<id>.*` and `thumbs/<id>.webp`, or `aws s3 rm s3://<photo-bucket>/photos/<id>.jpg --endpoint-url $EP`.
4. **Caches.** The bucket is private and reads go through short-lived presigned URLs, so once the
   objects are deleted no new URL works and old ones 404 at R2. What can linger: the redirect for an
   approved photo is cacheable by browsers and the Vercel CDN until the end of its one-hour signing
   window, and a browser that already loaded the image keeps its copy (objects written before the
   private-bucket change say `max-age=31536000`, newer ones `private, max-age=86400`). Nothing can
   force a browser to forget it. The service worker never stores `/api/media/` responses or R2 URLs.
5. **Follow up:** if the uploader is abusive, [ban them](#8-ban-a-user). If the photo came with a
   review, delete the review: `delete from "Review" where id = '<id>'` (photos of that review lose
   their link; they are not deleted by it).
6. Reply to the reporter from the contact address (`NEXT_PUBLIC_CONTACT_EMAIL`) and keep the report.

---

## 8. Ban a user

There is no ban switch in the app. The working lever is the same one account deletion uses:
`User.deletedAt`. Every request re-reads the user, and a user with `deletedAt` set is treated as
signed out (`auth.guard.ts`), so existing sessions die at once and signing in again does not revive
the account (login finds the row but the guard still rejects it). Run in the Neon SQL editor (production
database), inside a transaction, and read the `UPDATE` count before committing:

```sql
begin;
-- 1. find them (by email, handle or id)
select id, email, handle, role, "createdAt" from "User" where email = 'person@example.com' or handle = 'handle';

-- 2. ban: sessions stop working immediately, off the leaderboard, no elevated role
update "User"
   set "deletedAt" = now(), role = 'USER', "leaderboardOptIn" = false, handle = null
 where id = '<user id>';

-- 3. optional: disconnect their linked Telegram chat
update "TelegramChat" set "userId" = null where "userId" = '<user id>';

-- 4. optional: remove what they posted (photos: use runbook 7 for each id so the R2 objects go too)
delete from "Review"       where "userId" = '<user id>';
delete from "StatusReport" where "userId" = '<user id>';
select id, url from "Photo" where "uploadedById" = '<user id>';
commit;   -- or rollback;
```

Clearing `handle` frees it for someone else and removes their name from reviews; skip that line if
you want to keep an audit trail (the row keeps `email`).

**Limits to know:**

- It bans the *account*. The same person can sign in with another Google account, or contribute
  anonymously (device cookie, per-IP limits that are in memory per instance and only advisory).
  For a determined abuser add a Vercel Firewall custom rule blocking their IP (Project -> Firewall;
  Hobby allows a small number of custom rules).
- Accounts listed in `ADMIN_EMAILS` are promoted to ADMIN at every login. To demote an admin, remove
  the address from `ADMIN_EMAILS` (API project, Production), redeploy, *then* run
  `update "User" set role = 'USER' where email = '...'` (or `PATCH /admin/users/:id/role` as another admin).
- Un-ban: `update "User" set "deletedAt" = null where id = '<id>'`. A user who deleted their own
  account (PDPA) also has `deletedAt` set but their email was rewritten to `deleted-<id>@deleted.invalid`
  and their `googleSub` removed; do not "un-delete" those.
- Role changes through the API (`PATCH /admin/users/:id/role`, ADMIN only) cannot target yourself.

---

## 9. Pause the bot

Choose by how fast you need silence and whether you can run the CLI.

**Fastest, no deploy (recommended): remove the webhook.** Telegram stops calling the API at once.
From a shell with the production bot token:

```bash
env DATABASE_URL=unused AUTH_SECRET=0123456789abcdef0123 TELEGRAM_BOT_TOKEN=<prod token> \
  pnpm cli telegram:setup --delete
# add --drop-pending to throw away the updates Telegram queued meanwhile
```

Check the shell is not also loading a `backend/.env` that holds the *dev* bot's token (shell
variables win, which is what the `env ...` prefix is for). Telegram keeps undelivered updates for up
to 24 hours; without `--drop-pending` they flood in when you resume.

**Resume:** `pnpm cli telegram:setup --url https://<api>` with the production `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_BOT_USERNAME` (plus `--drop-pending` if the backlog is stale).
It re-registers the webhook, commands and descriptions.

**Without the CLI (dashboard only):** unset `TELEGRAM_BOT_TOKEN` on the API project and redeploy: the
bot module registers nothing and the webhook route is gone (Telegram gets 404s).
Slower than removing the webhook (a full redeploy each way).
Do **not** only blank `TELEGRAM_WEBHOOK_SECRET`: the route then answers 503 to every update, which
Telegram counts as failures and retries.

**Abusive single chat or group:** the bot is rate limited per chat (20 updates/min and 300/day in
private chats, 10/min and 200/day in groups, 5 check-ins and 10 reports per Singapore day), in
memory per instance. To remove a chat: have the user send `/stop`, or in a group remove the bot
(BotFather settings: `/setjoingroups` disabled stops it being added again). Row inspection:
`select type, count(*) from "TelegramChat" group by 1;` (the table holds chat ids only, no names or
messages).

**Bot token leaked:** [runbook 5](#5-rotate-the-telegram-webhook-secret), last paragraph.

---

## 10. Routine secrets and expiring things

| Thing | Cadence | How |
|---|---|---|
| `CRON_SECRET` | yearly, or if leaked | New random value in the API project (Production) **and** the GitHub secret `CRON_SECRET`; redeploy the API; run `maintenance` once from Actions. Mismatch shows as HTTP 401 in the nightly job. |
| OneMap account | when the password changes | `ONEMAP_EMAIL`/`ONEMAP_PASSWORD` in the API project (and the GitHub secrets used by imports). The token (3 days) is cached in the `KeyValue` table (`onemap:token`) and renewed 30 minutes before expiry; wrong credentials show up only as log warnings and straight-line estimates, so look at the logs after changing them. |
| Google OAuth client secret | yearly | Google Cloud console -> Credentials -> add a second secret, update `GOOGLE_CLIENT_SECRET` in Vercel, redeploy, delete the old secret. Check the consent screen is **In production** (Google Auth Platform -> Audience -> Publishing status), not Testing, which caps users at 100. |
| R2 API tokens (photos, backups) | yearly | Create the new token, update Vercel (`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`) or GitHub secrets (`R2_BACKUP_*`), redeploy / re-run the backup, revoke the old one. |
| Neon role password | if leaked | Neon console -> Roles -> reset password; update `DATABASE_URL`, `DIRECT_URL` (Vercel) and the GitHub secret `DIRECT_URL`; redeploy. |
| Scheduled workflows | if the heartbeat email stops | Actions -> Scheduled -> *Enable workflow*, then Run workflow -> `nightly`. GitHub disables schedules after 60 days without repository activity. |
| Restore drill | quarterly | Follow runbook 6B into a scratch database; fill in the drill log. |
