/**
 * Data pipeline and Telegram bot CLI. Usage: `pnpm cli <command> [flags]`. See data/README.md
 * and the Telegram section of README.md.
 * Deliberately framework-free (no Nest): each command is a plain async function. The one exception
 * is telegram:poll, which boots the Nest app context from the compiled build to run the bot's handlers.
 */
import { parseArgv } from './imports/lib/argv.js';
import { closeDb } from './imports/lib/db.js';
import { COMMANDS as IMPORT_COMMANDS } from './imports/commands.js';
import { TELEGRAM_COMMANDS } from './integrations/telegram/commands.js';

const COMMANDS = { ...IMPORT_COMMANDS, ...TELEGRAM_COMMANDS };

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const name = args.command;
  if (!name || name === 'help' || args.flags['help']) {
    console.log('Usage: pnpm cli <command> [flags]\n\nCommands:');
    for (const [n, c] of Object.entries(COMMANDS)) console.log(`  ${n.padEnd(18)} ${c.description}`);
    return;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    console.error(`Unknown command "${name}". Run \`pnpm cli help\`.`);
    process.exitCode = 2;
    return;
  }
  const t0 = Date.now();
  console.log(`> ${name}`);
  await cmd.run(args);
  console.log(`< ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
