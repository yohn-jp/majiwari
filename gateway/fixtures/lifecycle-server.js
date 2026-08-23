import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "lifecycle-fixture", version: "0.0.1" });

server.registerTool(
  "pid",
  {
    title: "Process ID",
    description: "Return the target process ID and label.",
    inputSchema: { label: z.string() }
  },
  async ({ label }) => ({ content: [{ type: "text", text: `${process.pid}:${label}` }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stdin.on("end", () => process.exit(0));
