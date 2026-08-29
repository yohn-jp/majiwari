import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function parseConfigArg(argv) {
  const index = argv.indexOf("--config");
  return index === -1 ? undefined : argv[index + 1];
}

const configPath = parseConfigArg(process.argv.slice(2));
const incompatible = process.env.MAJIWARI_TEST_MOTTAINAI_INCOMPATIBLE === "1";
if (process.env.MAJIWARI_TEST_MOTTAINAI_PID_FILE) {
  fs.writeFileSync(process.env.MAJIWARI_TEST_MOTTAINAI_PID_FILE, String(process.pid));
}
const work = new Map();
let nextWorkId = 1;
const workTools = [
  "mottainai_delegate_work",
  "mottainai_inspect_work",
  "mottainai_continue_work",
  "mottainai_cancel_work"
];

const server = new McpServer(
  { name: incompatible ? "not-mottainai" : "mottainai-mcp", version: "0.1.0" },
  { capabilities: {} }
);

server.registerTool(
  "mottainai_harness_capabilities",
  {
    title: "Mottainai harness capabilities",
    description: "Fixture matching the packaged native harness capability envelope.",
    inputSchema: { schemaVersion: z.literal(1).optional() }
  },
  async () => ({
    structuredContent: {
      schemaVersion: 1,
      operation: "mottainai_harness_capabilities",
      status: "completed",
      workId: null,
      summary: "native harness-delegation MCP capability metadata",
      lifecycle: null,
      evidence: {},
      artifacts: [],
      truncated: false,
      ...(configPath !== undefined && { configPath }),
      capabilities: {
        schemaVersion: incompatible ? 999 : 1,
        protocol: "mcp",
        transport: "stdio",
        tools: workTools,
        statuses: ["accepted", "running", "completed", "failed", "cancelled", "blocked", "missing"],
        errorClasses: ["invalid_input", "unavailable_capability", "lifecycle_conflict", "governed_refusal", "execution_failure", "internal_failure"],
        executable: "mottainai-mcp"
      }
    },
    content: [{ type: "text", text: configPath === undefined ? "fixture capabilities" : `config:${configPath}` }]
  })
);

server.registerTool(
  "mottainai_delegate_work",
  {
    title: "Delegate work",
    description: "Fixture: records a bounded goal and returns an opaque workId.",
    inputSchema: { goal: z.string(), idempotencyKey: z.string().optional() },
    outputSchema: { schemaVersion: z.literal(1), workId: z.string(), status: z.string() }
  },
  async ({ goal, idempotencyKey }) => {
    if (idempotencyKey) {
      for (const [workId, entry] of work) {
        if (entry.idempotencyKey === idempotencyKey) {
          return { structuredContent: { schemaVersion: 1, workId, status: entry.status }, content: [{ type: "text", text: workId }] };
        }
      }
    }
    const workId = `fake-work-${nextWorkId++}`;
    work.set(workId, { goal, idempotencyKey, status: "accepted" });
    return { structuredContent: { schemaVersion: 1, workId, status: "accepted" }, content: [{ type: "text", text: workId }] };
  }
);

server.registerTool(
  "mottainai_inspect_work",
  {
    title: "Inspect work",
    description: "Fixture: returns the recorded status for a previously delegated workId.",
    inputSchema: { workId: z.string() },
    outputSchema: { schemaVersion: z.literal(1), workId: z.string(), status: z.string() }
  },
  async ({ workId }) => {
    const entry = work.get(workId);
    const status = entry ? entry.status : "missing";
    return { structuredContent: { schemaVersion: 1, workId, status }, content: [{ type: "text", text: status }] };
  }
);

server.registerTool(
  "mottainai_continue_work",
  {
    title: "Continue work",
    description: "Fixture: transitions a recorded workId to running.",
    inputSchema: { workId: z.string() },
    outputSchema: { schemaVersion: z.literal(1), workId: z.string(), status: z.string() }
  },
  async ({ workId }) => {
    const entry = work.get(workId);
    if (entry) entry.status = "running";
    return { structuredContent: { schemaVersion: 1, workId, status: entry ? entry.status : "missing" }, content: [{ type: "text", text: workId }] };
  }
);

server.registerTool(
  "mottainai_cancel_work",
  {
    title: "Cancel work",
    description: "Fixture: transitions a recorded workId to cancelled.",
    inputSchema: { workId: z.string() },
    outputSchema: { schemaVersion: z.literal(1), workId: z.string(), status: z.string() }
  },
  async ({ workId }) => {
    const entry = work.get(workId);
    if (entry) entry.status = "cancelled";
    return { structuredContent: { schemaVersion: 1, workId, status: entry ? entry.status : "missing" }, content: [{ type: "text", text: workId }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
