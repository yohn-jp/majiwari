#!/usr/bin/env node
// Starts the operator UI shell against an empty AdapterRegistry. This shell
// contains zero adapter-specific code; a runtime that wires real adapters
// into the registry passed here is separate, later composition work.
import { AdapterRegistry } from "@majiwari/registry";
import { createUiServer } from "../src/server.js";

function parseArgs(argv, env) {
  const result = { port: env.MAJIWARI_UI_PORT ?? "4600", host: env.MAJIWARI_UI_HOST ?? "127.0.0.1" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port") {
      result.port = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === "--host") {
      result.host = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

const { port, host } = parseArgs(process.argv.slice(2), process.env);
const registry = new AdapterRegistry();
const server = createUiServer(registry);

server.listen(Number(port), host, () => {
  process.stdout.write(`majiwari operator UI listening on http://${host}:${port}\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
