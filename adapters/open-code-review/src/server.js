import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseServerArgs, resolveRepoRoot } from "./core.js";
import { createOcrServer } from "./build-server.js";

const cli = parseServerArgs(process.argv.slice(2));
if (cli.help) {
  process.stdout.write(`OpenCodeReview ChatGPT MCP adapter\n\nUsage:\n  node src/server.js [--repo /absolute/path/to/repository]\n\nEnvironment:\n  OCR_REPO                 fallback repository path\n  OCR_ADAPTER_TIMEOUT_MS   command timeout (default 30000)\n  OCR_ADAPTER_MAX_BUFFER   max command output bytes (default 10485760)\n`);
  process.exit(0);
}

const repoRoot = await resolveRepoRoot(cli.repo);

// Standalone mode is bound to this one repository for the process's whole
// lifetime, exactly as before #29: targetId is accepted on every
// workspace-sensitive tool (for schema/managed-mode parity) but ignored --
// there is nothing to select in a single-repository process.
const server = createOcrServer({
  resolveExecutionContext: async () => repoRoot,
  healthCwd: repoRoot
});

const transport = new StdioServerTransport();
await server.connect(transport);
