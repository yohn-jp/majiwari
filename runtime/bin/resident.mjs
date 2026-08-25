#!/usr/bin/env node
import { runResidentCli } from "../src/cli.js";

try {
  await runResidentCli();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
