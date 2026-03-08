#!/usr/bin/env node
import('../src/cli.mjs').then(({ main }) => main(process.argv.slice(2))).catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  console.error(message);
  process.exit(1);
});
