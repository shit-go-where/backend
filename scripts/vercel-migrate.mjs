// Guards the database steps of `pnpm vercel-build` (`prisma migrate deploy`, `node dist/sync-badges.js`):
//   node scripts/vercel-migrate.mjs <command...>
// runs the command, except on a Preview deployment that has no database of its own.
//
// The API project's DATABASE_URL / DIRECT_URL are shared by the Preview and Production
// environments, so a preview build would otherwise migrate the production database. The
// Preview DB workflow (.github/workflows/preview-db.yml) gives a PR its own Neon branch and sets
// PREVIEW_DB=1 on that git branch's Preview env; only then does a preview touch its database.
// Set PREVIEW_DB=1 project-wide if every preview is guaranteed its own database (for example
// through Neon's Vercel integration).
import { spawnSync } from 'node:child_process';

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error('usage: node scripts/vercel-migrate.mjs <command...>');
  process.exit(2);
}

if (process.env.VERCEL_ENV === 'preview' && process.env.PREVIEW_DB !== '1') {
  console.log(
    `vercel-migrate: preview deployment without its own database (PREVIEW_DB unset); skipping "${command.join(' ')}". ` +
      'Pending migrations are not applied, so a preview that needs them fails at runtime instead of touching production.',
  );
  process.exit(0);
}

const run = spawnSync(command[0], command.slice(1), { stdio: 'inherit', shell: true });
process.exit(run.status ?? 1);
