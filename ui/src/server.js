import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UnknownAdapterError } from "@majiwari/registry";
import { projectAdapterDetail, projectAdapterList } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const STATIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" }
};

const ADAPTER_DETAIL_PATH = /^\/api\/adapters\/([^/]+)$/;

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

async function sendStatic(res, entry) {
  try {
    const contents = await readFile(path.join(PUBLIC_DIR, entry.file));
    res.writeHead(200, { "Content-Type": entry.type });
    res.end(contents);
  } catch {
    sendNotFound(res);
  }
}

/**
 * Operator web UI shell HTTP server. Projects one AdapterRegistry's
 * list/detail/health/tools into JSON for the static frontend, plus serves
 * that frontend. Takes the registry as a parameter and never references a
 * specific adapter id -- registering another fixture adapter on the same
 * registry requires no change here.
 */
export function createUiServer(registry) {
  return createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      sendNotFound(res);
      return;
    }

    if (req.method !== "GET") {
      sendNotFound(res);
      return;
    }

    if (url.pathname === "/api/adapters") {
      sendJson(res, 200, projectAdapterList(registry));
      return;
    }

    const detailMatch = url.pathname.match(ADAPTER_DETAIL_PATH);
    if (detailMatch) {
      try {
        const detail = await projectAdapterDetail(registry, decodeURIComponent(detailMatch[1]));
        sendJson(res, 200, detail);
      } catch (error) {
        if (error instanceof UnknownAdapterError) {
          sendJson(res, 404, { error: error.message });
          return;
        }
        sendJson(res, 500, { error: "internal error" });
      }
      return;
    }

    const staticEntry = STATIC_FILES[url.pathname];
    if (staticEntry) {
      await sendStatic(res, staticEntry);
      return;
    }

    sendNotFound(res);
  });
}
