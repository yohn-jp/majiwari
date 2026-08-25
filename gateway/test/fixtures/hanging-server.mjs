#!/usr/bin/env node
// A stdio process that starts but never speaks MCP at all -- it never
// answers an `initialize` request or any probe. For testing that a
// client.connect() timeout releases what it partially acquired (this very
// process) instead of leaking it. Writes its own pid to `pidFile` first so
// the test can confirm the process is gone afterward.
import fs from "node:fs";

const pidFile = process.argv[2];
if (!pidFile) {
  process.stderr.write("usage: hanging-server.mjs <pid-file>\n");
  process.exit(1);
}

fs.writeFileSync(pidFile, String(process.pid));

// Keep the process alive doing nothing else; stdin is never read again.
process.stdin.resume();
