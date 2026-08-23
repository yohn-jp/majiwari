import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export function parseGatewayArgs(argv = [], env = {}) {
  const result = { command: undefined, args: [], port: undefined, host: "127.0.0.1", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
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
  result.port = Number(result.port);
  return result;
}

/**
 * Bridges a single spawned stdio MCP server to Streamable HTTP by wiring
 * Transport-level send/onmessage directly together. JSON-RPC messages pass
 * through unmodified -- this layer never parses tool names, schemas, or results.
 */
export function bridgeTransports(stdioTransport, httpTransport) {
  stdioTransport.onmessage = (message, extra) => {
    httpTransport.send(message, extra?.relatedRequestId !== undefined ? { relatedRequestId: extra.relatedRequestId } : undefined);
  };
  httpTransport.onmessage = (message) => {
    stdioTransport.send(message);
  };
}

export async function createGateway({ command, args = [], host = "127.0.0.1", port }) {
  if (!command) throw new Error("gateway requires a target stdio MCP command (--command, positional arg, or MAJIWARI_TARGET_COMMAND)");

  const stdioTransport = new StdioClientTransport({ command, args });
  const sessions = new Map();

  const httpServer = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    let httpTransport = sessionId ? sessions.get(sessionId) : undefined;

    if (!httpTransport) {
      httpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, httpTransport)
      });
      httpTransport.onclose = () => {
        if (httpTransport.sessionId) sessions.delete(httpTransport.sessionId);
      };
      bridgeTransports(stdioTransport, httpTransport);
      await httpTransport.start();
    }

    await httpTransport.handleRequest(req, res);
  });

  await stdioTransport.start();

  async function close() {
    await new Promise((resolve) => httpServer.close(() => resolve()));
    for (const transport of sessions.values()) await transport.close();
    await stdioTransport.close();
  }

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });

  return { httpServer, stdioTransport, close, port, host };
}

async function main() {
  const cli = parseGatewayArgs(process.argv.slice(2), process.env);
  if (cli.help) {
    process.stdout.write(`Majiwari generic stdio MCP to Streamable HTTP gateway\n\nUsage:\n  node src/server.js [--host 127.0.0.1] [--port 8787] -- <stdio-mcp-command> [args...]\n\nEnvironment:\n  MAJIWARI_TARGET_COMMAND   fallback target command\n  MAJIWARI_TARGET_ARGS      fallback target args (space-separated)\n  MAJIWARI_GATEWAY_PORT     fallback port (default 8787)\n`);
    process.exit(0);
  }

  const gateway = await createGateway(cli);
  process.stdout.write(`majiwari gateway listening on http://${gateway.host}:${gateway.port}/mcp\n`);

  const shutdown = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
