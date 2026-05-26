#!/usr/bin/env node

const { runCli } = require('../src/cli');

runCli(process.argv.slice(2)).catch(err => {
  console.error(`[harmony-evo-client] ${err.message}`);
  process.exit(1);
});
