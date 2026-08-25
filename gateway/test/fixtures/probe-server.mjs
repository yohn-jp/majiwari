#!/usr/bin/env node
// A minimal stdio MCP server for gateway tests. Registers exactly one tool,
// named after the adapter id it is given, that reports its own adapter id
// and process id -- enough for a test to prove which adapter actually
// answered a call, and that two adapters run as two distinct processes.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const id = process.argv[2];
if (!id) {
  process.stderr.write("usage: probe-server.mjs <adapter-id>\n");
  process.exit(1);
}

const server = new McpServer({ name: id, version: "1.0.0" }, { capabilities: { tools: {} } });

server.registerTool(
  `${id}_probe`,
  { title: `${id} probe`, description: `Reports which adapter process answered the call.` },
  async () => ({
    content: [{ type: "text", text: JSON.stringify({ adapterId: id, pid: process.pid }) }]
  })
);

await server.connect(new StdioServerTransport());
