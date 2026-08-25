import { AdapterRegistry } from "@majiwari/registry";
import { parseServerArgs } from "./core.js";
import { createManifest } from "./manifest.js";

const cli = parseServerArgs(process.argv.slice(2));
if (cli.help) {
  process.stdout.write(
    "Usage: node src/runtime.js [--repo /absolute/path/to/repository]\n\nRegisters the Inari adapter through @majiwari/registry's AdapterRegistry and starts it as a stdio MCP server.\n"
  );
  process.exit(0);
}

const registry = new AdapterRegistry();
const manifest = createManifest({ repo: cli.repo });
registry.register(manifest);

const status = await registry.start(manifest.id);
if (status.state !== "running") {
  process.stderr.write(`failed to start ${manifest.id}: ${status.error}\n`);
  process.exitCode = 1;
} else {
  process.stderr.write(`${manifest.id}@${manifest.version} registered and running via @majiwari/registry.\n`);
}

const shutdown = async () => {
  await registry.stop(manifest.id);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
