/**
 * Data pipeline CLI. Usage: `pnpm cli <command> [flags]`. See data/README.md.
 * Deliberately framework-free (no Nest): each command is a plain async function.
 */
import { parseArgv } from './imports/lib/argv.js';
import { closeDb } from './imports/lib/db.js';
import { COMMANDS } from './imports/commands.js';

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
