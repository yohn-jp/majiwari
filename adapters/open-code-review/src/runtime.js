import { AdapterRegistry } from "@majiwari/registry";
import { parseServerArgs } from "./core.js";
import { createLocalTargetProvider } from "./local-target-provider.js";
import { createManifest } from "./manifest.js";

/**
 * Pull repeatable `--target <id>=<absolute-repo-path>` flags out of argv
 * before handing the remainder to `parseServerArgs` (`--repo`/`--help`,
 * unchanged and shared with `server.js`/`doctor.js`). This is the manual,
 * adapter-local entry point for the #29 two-target resident smoke: one
 * `AdapterRegistry`-managed OCR adapter, one local target provider seeded
 * from these flags, no restart between targets.
 */
function extractTargetFlags(argv) {
  const rest = [];
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--target") {
      rest.push(arg);
      continue;
    }
    const value = argv[index + 1];
    const separator = value?.indexOf("=") ?? -1;
    if (!value || separator <= 0 || separator === value.length - 1) {
      throw new Error("--target requires <id>=<absolute-repo-path>");
    }
    targets.push({ id: value.slice(0, separator), repoRoot: value.slice(separator + 1) });
    index += 1;
  }
  return { targets, rest };
}

let cli;
let targets;
try {
  const parsed = extractTargetFlags(process.argv.slice(2));
  targets = parsed.targets;
  cli = parseServerArgs(parsed.rest);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

if (cli.help) {
  process.stdout.write(
    "Usage: node src/runtime.js [--repo /absolute/path/to/repository]\n" +
      "       node src/runtime.js --target <id>=/absolute/path/to/repo [--target <id>=/absolute/path/to/repo ...]\n\n" +
      "Registers the OCR adapter through @majiwari/registry's AdapterRegistry and starts it as a stdio MCP server.\n" +
      "--target (repeatable) switches to managed target-provider mode (#29): one resident adapter serving every\n" +
      "given targetId from a local fixture provider, with no process-global/current target and no restart\n" +
      "required to move between them. --repo and --target are mutually exclusive.\n"
  );
  process.exit(0);
}

if (targets.length > 0 && cli.repo) {
  process.stderr.write("--target and --repo are mutually exclusive\n");
  process.exit(1);
}

const registry = new AdapterRegistry();
const manifest = targets.length > 0 ? createManifest({ targetProvider: createLocalTargetProvider(targets) }) : createManifest({ repo: cli.repo });
registry.register(manifest);

const status = await registry.start(manifest.id);
if (status.state !== "running") {
  process.stderr.write(`failed to start ${manifest.id}: ${status.error}\n`);
  process.exitCode = 1;
} else {
  const mode = targets.length > 0 ? `managed, targets: ${targets.map((t) => t.id).join(", ")}` : "standalone";
  process.stderr.write(`${manifest.id}@${manifest.version} registered and running via @majiwari/registry (${mode}).\n`);
}

const shutdown = async () => {
  await registry.stop(manifest.id);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
