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

  const sessions = new Map();
  const activeSessions = new Set();
  let closing = false;
  let closePromise;

  function createSession() {
    let session;
    const stdioTransport = new StdioClientTransport({ command, args });
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.sessionId = id;
        sessions.set(id, session);
      },
      onsessionclosed: async () => {
        await closeSession(session);
      }
    });

    session = { httpTransport, stdioTransport, sessionId: undefined, closePromise: undefined, closed: false };
    activeSessions.add(session);

    httpTransport.onclose = () => {
      void closeSession(session);
    };
    stdioTransport.onclose = () => {
      void closeSession(session);
    };
    bridgeTransports(stdioTransport, httpTransport);
    return session;
  }

  function closeSession(session) {
    if (session.closePromise) return session.closePromise;

    session.closed = true;
    if (session.sessionId !== undefined && sessions.get(session.sessionId) === session) {
      sessions.delete(session.sessionId);
    }
    session.closePromise = Promise.resolve().then(async () => {
      try {
        await session.httpTransport.close();
      } finally {
        await session.stdioTransport.close();
        activeSessions.delete(session);
      }
    });
    return session.closePromise;
  }

  async function startSession(session) {
    try {
      await session.stdioTransport.start();
      await session.httpTransport.start();
    } catch (error) {
      await closeSession(session);
      throw error;
    }
  }

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
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (sessionId && (!session || session.closed)) {
      res.writeHead(404).end();
      return;
    }

    if (!session) {
      if (closing) {
        res.writeHead(503).end();
        return;
      }
      session = createSession();
      try {
        await startSession(session);
      } catch (error) {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy(error);
        return;
      }
    }

    try {
      await session.httpTransport.handleRequest(req, res);
    } catch (error) {
      await closeSession(session);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy(error);
      return;
    }

    if (session.httpTransport.sessionId === undefined) await closeSession(session);
  });

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const results = await Promise.allSettled([...activeSessions].map((session) => closeSession(session)));
      await new Promise((resolve) => httpServer.close(() => resolve()));
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    })();
    return closePromise;
  }

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });

  return { httpServer, close, port, host };
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
