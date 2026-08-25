import { createResidentRuntime, installResidentSignalHandlers } from "./index.js";
import { DEFAULT_RESIDENT_CONFIG_FILE, loadResidentConfig } from "./config.js";

export function parseResidentArgs(argv = []) {
  const result = { config: DEFAULT_RESIDENT_CONFIG_FILE, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--config requires a file path");
      result.config = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

export function residentHelp() {
  return [
    "Usage: npm run resident -- --config /path/to/majiwari.runtime.json",
    "",
    "Starts the trusted OCR and/or Inari adapters from a version-1 local config",
    "on one loopback ingress (127.0.0.1). See README.md for the config schema."
  ].join("\n");
}

/** Run the resident CLI; the returned runtime remains alive until a signal. */
export async function runResidentCli(argv = process.argv.slice(2), { processRef = process } = {}) {
  const args = parseResidentArgs(argv);
  if (args.help) {
    processRef.stdout.write(`${residentHelp()}\n`);
    return;
  }

  const config = await loadResidentConfig(args.config);
  const runtime = createResidentRuntime(config);
  const signals = installResidentSignalHandlers(runtime, {
    processRef,
    exit: (code) => processRef.exit(code)
  });

  try {
    await runtime.start();
    processRef.stdout.write(`majiwari resident runtime listening on http://127.0.0.1:${runtime.port}\n`);
    for (const id of runtime.attachFailures.keys()) {
      processRef.stderr.write(`majiwari resident adapter "${id}" could not be attached\n`);
    }
    return runtime;
  } catch (error) {
    signals.dispose();
    await runtime.shutdown();
    processRef.stderr.write(`${error.message}\n`);
    processRef.exitCode = 1;
  }
}
