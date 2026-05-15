#!/usr/bin/env node
import { HelpRequested, parseArgs, usage } from "./config.js";
import { runRelay } from "./relay.js";

try {
  const config = parseArgs(process.argv.slice(2));
  await runRelay({ config });
} catch (error) {
  if (error instanceof HelpRequested) {
    console.log(usage());
    process.exitCode = 0;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
