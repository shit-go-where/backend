/**
 * Telegram CLI commands (BOT.md §6 Operations), merged into `pnpm cli` by src/cli.ts.
 *
 *   pnpm cli telegram:setup [--url <api origin>] [--drop-pending] [--delete]
 *   pnpm cli telegram:poll [--force]
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Api } from 'grammy';
import { flagBool, flagStr } from '../../imports/lib/argv.js';
import type { Command } from '../../imports/commands.js';
import {
  ALLOWED_UPDATES,
  BOT_DESCRIPTION,
  BOT_SHORT_DESCRIPTION,
  GROUP_COMMANDS,
  PRIVATE_COMMANDS,
} from './format.js';

const WEBHOOK_PATH = '/integrations/telegram';

/** Default webhook: the app origin's /api rewrite, which forwards to the API. `--url` names the API origin. */
export function webhookUrl(publicAppUrl: string, apiOrigin?: string): string {
  const base = apiOrigin ? apiOrigin.replace(/\/+$/, '') : `${publicAppUrl.replace(/\/+$/, '')}/api`;
  return `${base}${WEBHOOK_PATH}`;
}

async function loadEnv() {
  const { env } = await import('../../config/env.js');
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Set TELEGRAM_BOT_TOKEN (from BotFather) first');
  return { ...env, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN };
}

/**
 * Nest's DI needs decorator metadata, which tsx (what `pnpm cli` runs) does not emit. So under tsx,
 * build once and re-run this command from dist/. Returns true when it handed over.
 */
function reRunCompiled(): boolean {
  if (!import.meta.url.endsWith('.ts')) return false;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  console.log('  building first (tsx has no decorator metadata, which Nest needs)...');
  const build = spawnSync('pnpm exec nest build', { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) throw new Error('nest build failed');
  const run = spawnSync(process.execPath, ['dist/cli.js', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
  return true;
}

export const TELEGRAM_COMMANDS: Record<string, Command> = {
  'telegram:setup': {
    description:
      'Register the webhook (with TELEGRAM_WEBHOOK_SECRET), commands and descriptions. --url <api origin>, --drop-pending, --delete',
    run: async (args) => {
      const env = await loadEnv();
      const api = new Api(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT } : undefined);
      const me = await api.getMe();
      console.log(`  bot @${me.username}`);
      if (env.TELEGRAM_BOT_USERNAME && env.TELEGRAM_BOT_USERNAME.replace(/^@/, '') !== me.username) {
        console.warn(`  ! TELEGRAM_BOT_USERNAME is "${env.TELEGRAM_BOT_USERNAME}" but the token belongs to @${me.username}`);
      }
      if (flagBool(args.flags, 'delete')) {
        await api.deleteWebhook({ drop_pending_updates: flagBool(args.flags, 'drop-pending') });
        console.log('  webhook deleted');
        return;
      }
      if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error('Set TELEGRAM_WEBHOOK_SECRET (32+ random characters) first');
      const url = webhookUrl(env.PUBLIC_APP_URL, flagStr(args.flags, 'url'));
      if (!url.startsWith('https://') && !env.TELEGRAM_API_ROOT) {
        throw new Error(`Telegram only calls https webhooks; got ${url}. Pass --url https://<api origin>.`);
      }
      await api.setWebhook(url, {
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: [...ALLOWED_UPDATES],
        drop_pending_updates: flagBool(args.flags, 'drop-pending'),
      });
      console.log(`  webhook -> ${url}`);
      await api.setMyCommands(PRIVATE_COMMANDS, { scope: { type: 'all_private_chats' } });
      await api.setMyCommands(GROUP_COMMANDS, { scope: { type: 'all_group_chats' } });
      await api.setMyDescription(BOT_DESCRIPTION);
      await api.setMyShortDescription(BOT_SHORT_DESCRIPTION);
      console.log('  commands, description and about text set');
      const info = await api.getWebhookInfo();
      console.log(`  pending updates: ${info.pending_update_count}${info.last_error_message ? `, last error: ${info.last_error_message}` : ''}`);
    },
  },
  'telegram:poll': {
    description: 'Run the bot locally with long polling (no tunnel). Refuses while a webhook is set unless --force',
    run: async (args) => {
      if (reRunCompiled()) return;
      const env = await loadEnv();
      const { NestFactory } = await import('@nestjs/core');
      const { AppModule } = await import('../../app.module.js');
      const { TelegramService } = await import('./telegram.service.js');
      const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
      try {
        const telegram = app.get(TelegramService);
        const hook = await telegram.bot.api.getWebhookInfo();
        if (hook.url && !flagBool(args.flags, 'force')) {
          throw new Error(
            `This bot has a webhook (${hook.url}); polling would delete it. Use a separate dev bot token, ` +
              'or pass --force and run telegram:setup again afterwards.',
          );
        }
        const stop = () => void telegram.stopPolling();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        await telegram.startPolling((username) =>
          console.log(`  polling as @${username} (links point at ${env.PUBLIC_APP_URL}). Ctrl+C to stop.`),
        );
      } finally {
        await app.close();
      }
    },
  },
};
