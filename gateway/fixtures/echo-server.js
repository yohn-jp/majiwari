import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "0.0.1" });

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Return the given text unchanged.",
    inputSchema: { text: z.string() }
  },
  async ({ text }) => ({ content: [{ type: "text", text }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);
