import { buildProgram } from './program.js';

/**
 *   npm run webhook -- signal --direction SELL
 *   npm run webhook -- bars --count 4
 *   npm run webhook -- discord
 *   npm run webhook -- health
 */
const program = buildProgram({
  env: process.env,
  fetch,
  print: console.log,
  printError: console.error,
  fail: () => {
    process.exitCode = 1;
  },
});

await program.parseAsync();
