import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkAdapterHealth, resolveRepoRoot } from "./core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "server.js");

export const ADAPTER_ID = "open-code-review";
export const ADAPTER_VERSION = "0.1.0";

/**
 * Build the @majiwari/registry manifest for the OCR adapter. Registering
 * this manifest starts the same unchanged stdio MCP server (src/server.js)
 * as a child process -- it is a second way to host it, not a replacement.
 * `npm start` keeps running src/server.js standalone, independent of the
 * registry.
 */
export function createManifest({ repo } = {}) {
  let child;

  return {
    schemaVersion: "1",
    id: ADAPTER_ID,
    version: ADAPTER_VERSION,
    displayName: "OpenCodeReview",
    transport: {
      kind: "stdio",
      start: async () => {
        const args = [SERVER_ENTRY];
        if (repo) args.push("--repo", repo);
        const proc = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
        await new Promise((resolveSpawn, reject) => {
          proc.once("spawn", resolveSpawn);
          proc.once("error", reject);
        });
        child = proc;
        return proc;
      },
      stop: async (handle) => {
        const proc = handle ?? child;
        child = undefined;
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
        await new Promise((resolveExit) => {
          proc.once("exit", resolveExit);
          proc.kill("SIGTERM");
        });
      }
    },
    health: async () => {
      const repoRoot = await resolveRepoRoot(repo);
      return checkAdapterHealth(repoRoot);
    },
    capabilities: ["code-review", "read-only"]
  };
}
