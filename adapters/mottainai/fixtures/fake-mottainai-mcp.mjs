import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * A fake stand-in for the real, installed `mottainai-mcp` packaged
 * entrypoint (yohn-jp/mottainai#548). It exists only so this repository's
 * own tests can prove the adapter's stdio/gateway plumbing (spawn, publish
 * at `/mcp/mottainai`, live tool discovery, a real tool-call round trip,
 * lifecycle isolation from a sibling adapter) without depending on the real
 * Mottainai package being installed wherever these tests run -- the same
 * role `adapters/inari/fixtures/sibling-server.js` and the OCR fake-CLI
 * helper play for their own adapters.
 *
 * It registers the same five tool *names* the real contract documents
 * (`docs/mcp-harness-delegation.md` in yohn-jp/mottainai) so a test can
 * assert the adapter's `/mcp/mottainai` route republishes them unchanged,
 * but its actual behavior is a deliberately trivial, deterministic fixture
 * -- it is not a reimplementation of Mottainai's lifecycle/idempotency
 * semantics, only enough state to prove a call and its result travel
 * through the gateway unmodified. `--config <path>` is echoed back verbatim
 * so a test can confirm the adapter passes that flag through unchanged and
 * injects nothing else.
 *
 * Deliberately kept outside `test/`: Node's test runner default glob
 * (`**\/test/**\/*.{js,cjs,mjs}`) would otherwise treat this file as its
 * own isolated test file, hanging `node --test` forever waiting on stdin.
 */
function parseConfigArg(argv) {
  const index = argv.indexOf("--config");
  return index === -1 ? undefined : argv[index + 1];
}

const configPath = parseConfigArg(process.argv.slice(2));
const work = new Map();
let nextWorkId = 1;

const server = new McpServer({ name: "fake-mottainai-mcp", version: "0.1.0" }, { capabilities: {} });

server.registerTool(
  "mottainai_harness_capabilities",
  {
    title: "Mottainai harness capabilities",
    description: "Fixture: reports schemaVersion and the --config path this fake process received.",
    inputSchema: {},
    outputSchema: { schemaVersion: z.literal(1), configPath: z.string().optional() }
  },
  async () => ({
    structuredContent: { schemaVersion: 1, ...(configPath !== undefined && { configPath }) },
    content: [{ type: "text", text: "fake-mottainai-mcp capabilities" }]
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
