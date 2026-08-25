import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ID_PATTERN, UnknownAdapterError } from "@majiwari/registry";
import { projectAdapterDetail, projectAdapterList } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" }
};

const ADAPTER_DETAIL_PATH = new RegExp(`^/api/adapters/(${ID_PATTERN.source.slice(1, -1)})$`);

function normalizeBasePath(basePath = "/") {
  if (basePath === "/" || basePath === "") return "";
  if (typeof basePath !== "string" || !basePath.startsWith("/") || basePath.endsWith("/")) {
    throw new TypeError('UI basePath must be "/" or a slash-prefixed path without a trailing slash');
  }
  return basePath;
}

function localPath(pathname, basePath) {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length) || "/";
  return undefined;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendNotFound(res, message = "not found") {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

async function sendStatic(res, entry, basePath) {
  try {
    let contents = await readFile(path.join(PUBLIC_DIR, entry.file));
    if (entry.file === "index.html") {
      const assetBase = basePath || "";
      contents = contents
        .toString()
        .replace('href="/style.css"', `href="${assetBase}/style.css"`)
        .replace('src="/app.js"', `src="${assetBase}/app.js"`);
    }
    res.writeHead(200, { "Content-Type": entry.type });
    res.end(contents);
  } catch {
    sendNotFound(res);
  }
}

/**
 * Build an embeddable UI request handler. It claims only its configured
 * namespace and returns false for unrelated paths, allowing an external
 * ingress to compose it with the gateway without either component owning the
 * other's routes or the public listening socket.
 */
export function createUiHandler(registry, { basePath = "/" } = {}) {
  const normalizedBasePath = normalizeBasePath(basePath);

  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }

    const pathname = localPath(url.pathname, normalizedBasePath);
    if (pathname === undefined) return false;
    if (req.method !== "GET") {
      sendNotFound(res);
      return true;
    }

    if (pathname === "/api/adapters") {
      sendJson(res, 200, projectAdapterList(registry));
      return true;
    }

    // The raw segment is checked against the registry ID contract. No
    // decodeURIComponent() is needed, so malformed percent encoding and
    // path-shaped identifiers fail closed with a bounded 404.
    const detailMatch = ADAPTER_DETAIL_PATH.exec(pathname);
    if (detailMatch) {
      try {
        const detail = await projectAdapterDetail(registry, detailMatch[1]);
        sendJson(res, 200, detail);
      } catch (error) {
        if (error instanceof UnknownAdapterError) {
          sendJson(res, 404, { error: error.message });
          return true;
        }
        sendJson(res, 500, { error: "internal error" });
      }
      return true;
    }

    const staticEntry = STATIC_FILES[pathname];
    if (staticEntry) {
      await sendStatic(res, staticEntry, normalizedBasePath);
      return true;
    }

    sendNotFound(res);
    return true;
  };
}

/** Mount the UI handler on an externally owned Node HTTP server. */
export function mountUi(registry, server, options) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("UI mount requires an externally owned Node HTTP server");
  }
  const handler = createUiHandler(registry, options);
  server.on("request", handler);
  return {
    handler,
    unmount: () => server.off("request", handler)
  };
}

/** Alias emphasizing that this object is a mount, not a listening server. */
export const createUiMount = mountUi;

/**
 * Standalone UI server retained for `npm run ui` and existing consumers.
 * Its default namespace is root; pass `{ basePath: "/ui" }` when a dedicated
 * server should expose the same mounted route contract.
 */
export function createUiServer(registry, options = {}) {
  const handler = createUiHandler(registry, options);
  return createServer(async (req, res) => {
    if (!(await handler(req, res))) sendNotFound(res);
  });
}
