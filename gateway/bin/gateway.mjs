#!/usr/bin/env node
// Thin wrapper around mcp-proxy (https://github.com/punkpeye/mcp-proxy):
// binds to 127.0.0.1 by default (this gateway is only ever reached over a
// Cloudflare Tunnel or Workers VPC Service, never directly from outside the
// host), and keeps this project's MAJIWARI_* environment-variable fallbacks
// for the target stdio command.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function parseArgs(argv, env) {
  const result = { command: undefined, args: [], port: undefined, host: "127.0.0.1" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      result.port = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--host") {
      result.host = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--") {
      result.command = argv[index + 1];
      result.args = argv.slice(index + 2);
      break;
    }
    if (result.command === undefined) {
      result.command = arg;
      continue;
    }
    result.args.push(arg);
  }
  if (result.command === undefined) result.command = env.MAJIWARI_TARGET_COMMAND;
  if (!result.args.length && env.MAJIWARI_TARGET_ARGS) result.args = env.MAJIWARI_TARGET_ARGS.split(" ").filter(Boolean);
  if (result.port === undefined) result.port = env.MAJIWARI_GATEWAY_PORT ?? "8787";
  return result;
}

const cli = parseArgs(process.argv.slice(2), process.env);
if (!cli.command) {
  process.stderr.write("gateway requires a target stdio MCP command (positional arg, or MAJIWARI_TARGET_COMMAND)\n");
  process.exit(1);
}

const mcpProxyPackageJson = require.resolve("mcp-proxy/package.json");
const mcpProxyBin = mcpProxyPackageJson.replace(/package\.json$/, "dist/bin/mcp-proxy.mjs");

const child = spawn(
  process.execPath,
  [mcpProxyBin, "--port", cli.port, "--host", cli.host, "--server", "stream", "--", cli.command, ...cli.args],
  { stdio: "inherit" }
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
