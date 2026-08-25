import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * A trivial, unrelated stdio MCP server used only by
 * test/gateway-integration.test.js to prove that a stopped/crashed Inari
 * adapter does not affect a sibling adapter published on the same gateway.
 * Deliberately kept outside `test/` -- Node's test runner default glob
 * (`**\/test/**\/*.{js,cjs,mjs}`) treats every .js file nested under a
 * directory literally named "test" as its own isolated test file (spawned
 * the same way this fixture is spawned as an MCP server child process), so
 * this file would otherwise hang `node --test` forever waiting on stdin.
 */
const server = new McpServer({ name: "inari-test-sibling", version: "1.0.0" }, { capabilities: {} });

server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Fixture tool: always returns { pong: true }.",
    inputSchema: {},
    outputSchema: { pong: z.boolean() }
  },
  async () => ({ structuredContent: { pong: true }, content: [{ type: "text", text: "pong" }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);
