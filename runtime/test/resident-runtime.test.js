import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AdapterState } from "@majiwari/registry";
import { createRegistryGateway, createStdioGatewayTransport } from "@majiwari/gateway";
import { createUiHandler } from "@majiwari/ui";
import {
  createResidentRuntime,
  installResidentSignalHandlers,
  TRUSTED_RESIDENT_CATALOG
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const PROBE_SERVER = fileURLToPath(new URL("../../gateway/test/fixtures/probe-server.mjs", import.meta.url));
const PRIVATE_REPO = path.join(os.tmpdir(), "majiwari-private-resident-repo");

function config(port, { ocr = true, inari = true, repo = PRIVATE_REPO } = {}) {
  return {
    version: 1,
    port,
    adapters: {
      ...(ocr ? { "open-code-review": { enabled: true, repo } } : {}),
      ...(inari ? { inari: { enabled: true, repo } } : {})
    }
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function probeManifest(id, calls = {}) {
  const transport = createStdioGatewayTransport({
    command: process.execPath,
    args: [PROBE_SERVER, id]
  });
  return {
    schemaVersion: "1",
    id,
    version: "1.0.0",
    displayName: `Resident ${id}`,
    transport: {
      kind: "stdio",
      start: () => transport.start(),
      stop: async (handle) => {
        calls.stopped = (calls.stopped ?? 0) + 1;
        await transport.stop(handle);
      }
    },
    listTools: async () => [{ name: `${id}_probe` }],
    capabilities: ["fixture"]
  };
}

function failingManifest(id, calls) {
  return {
    schemaVersion: "1",
    id,
    version: "1.0.0",
    transport: {
      kind: "stdio",
      start: async () => {
        calls.started = (calls.started ?? 0) + 1;
        throw new Error("fixture startup failed");
      },
      stop: async () => {
        calls.stopped = (calls.stopped ?? 0) + 1;
      }
    }
  };
}

function nonRoutableManifest(id, calls) {
  return {
    schemaVersion: "1",
    id,
    version: "1.0.0",
    transport: {
      kind: "stdio",
      start: async () => {
        calls.started = (calls.started ?? 0) + 1;
        return {};
      },
      stop: async () => {
        calls.stopped = (calls.stopped ?? 0) + 1;
      }
    }
  };
}

function fixtureCatalog({ ocr, inari }) {
  return {
    "open-code-review": () => ocr(),
    inari: () => inari()
  };
}

async function connectClient(port, id) {
  const client = new Client({ name: `resident-${id}`, version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${id}`)));
  return client;
}

function rawGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "GET", path: pathname }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`child process ${pid} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("resident runtime serves two adapters and UI from one registry/loopback ingress", async () => {
  const port = await getFreePort();
  const calls = { ocr: {}, inari: {} };
  let gatewayRegistry;
  let uiRegistry;
  const runtime = createResidentRuntime(config(port), {
    gatewayFactory: async (options) => {
      gatewayRegistry = options.registry;
      return createRegistryGateway(options);
    },
    uiFactory: (registry, options) => {
      uiRegistry = registry;
      return createUiHandler(registry, options);
    },
    catalog: fixtureCatalog({
      ocr: () => probeManifest("open-code-review", calls.ocr),
      inari: () => probeManifest("inari", calls.inari)
    })
  });
  let ocrClient;
  let inariClient;
  let pids = [];

  try {
    await runtime.start();
    assert.equal(runtime.server.address().address, "127.0.0.1");
    assert.equal(runtime.port, port);
    assert.equal(gatewayRegistry, runtime.registry);
    assert.equal(uiRegistry, runtime.registry);
    assert.deepEqual(runtime.attachedAdapterIds.sort(), ["inari", "open-code-review"]);

    pids = [runtime.registry.resource("open-code-review"), runtime.registry.resource("inari")].map(
      (resource) => resource.mcpClient.transport.pid
    );
    assert.ok(pids.every(isProcessAlive));

    ocrClient = await connectClient(port, "open-code-review");
    inariClient = await connectClient(port, "inari");
    assert.deepEqual((await ocrClient.listTools()).tools.map((tool) => tool.name), ["open-code-review_probe"]);
    assert.deepEqual((await inariClient.listTools()).tools.map((tool) => tool.name), ["inari_probe"]);
    assert.equal(JSON.parse((await ocrClient.callTool({ name: "open-code-review_probe" })).content[0].text).adapterId, "open-code-review");
    assert.equal(JSON.parse((await inariClient.callTool({ name: "inari_probe" })).content[0].text).adapterId, "inari");
    await assert.rejects(() => ocrClient.callTool({ name: "inari_probe" }));

    assert.equal((await fetch(`http://127.0.0.1:${port}/ui`)).status, 200);
    const listResponse = await fetch(`http://127.0.0.1:${port}/ui/api/adapters`);
    const list = await listResponse.json();
    assert.deepEqual(list.map((adapter) => adapter.id).sort(), ["inari", "open-code-review"]);
    assert.ok(list.every((adapter) => adapter.state === AdapterState.RUNNING));
    assert.ok(list.every((adapter) => !("resource" in adapter)));
    const detail = await fetch(`http://127.0.0.1:${port}/ui/api/adapters/open-code-review`);
    const detailBody = await detail.json();
    assert.deepEqual(detailBody.tools.items.map((tool) => tool.name), ["open-code-review_probe"]);
    assert.ok(!JSON.stringify(detailBody).includes(PRIVATE_REPO));

    for (const pathname of [
      "/mcp/open-code-review/extra",
      "/mcp/%zz",
      "/mcp/../etc/passwd",
      "/ui/api/adapters/%zz",
      "/unrelated"
    ]) {
      const status = await rawGet(port, pathname);
      assert.ok(status >= 400 && status < 500, `${pathname} returned ${status}`);
    }
  } finally {
    await ocrClient?.close().catch(() => {});
    await inariClient?.close().catch(() => {});
    await runtime.shutdown();
    for (const pid of pids) await waitForExit(pid);
    assert.equal(runtime.server.listening, false);
    assert.equal(runtime.server.listenerCount("request"), 0);
    assert.equal(calls.ocr.stopped, 1);
    assert.equal(calls.inari.stopped, 1);
  }
});

test("real OCR and Inari manifests are independently reachable through resident ingress", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "majiwari-resident-tools-"));
  const originalPath = process.env.PATH;
  const ocr = path.join(binDir, "ocr");
  const inari = path.join(binDir, "inari");
  const gh = path.join(binDir, "gh");
  fs.writeFileSync(
    ocr,
    "#!/bin/sh\ncase \"$1 $2\" in\n  \"--version \"*) echo 1.0.0 ;;\n  \"delegate preview\"*) echo --format ;;\n  \"delegate rule\"*) echo --format ;;\n  \"scan --help\"*) echo --preview --format ;;\n  \"rules check\"*) echo '<file-path>' ;;\n  *) echo '{}' ;;\nesac\n"
  );
  fs.writeFileSync(
    inari,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '{\"ok\":true,\"name\":\"gh-inari\",\"version\":\"0.1.0\",\"protocol\":1,\"capabilities\":[\"machine-readable-version\"]}'; exit 0; fi\nif [ \"$1\" = \"template\" ] && [ \"$2\" = \"list\" ]; then echo '{\"templates\":[{\"id\":\"feature\"}],\"semanticTemplates\":[]}'; exit 0; fi\necho '{\"ok\":true}'\n"
  );
  fs.writeFileSync(gh, "#!/bin/sh\nexit 0\n");
  for (const file of [ocr, inari, gh]) fs.chmodSync(file, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  const port = await getFreePort();
  const runtime = createResidentRuntime(config(port, { repo: ROOT }));
  let ocrClient;
  let inariClient;
  let pids = [];
  try {
    await runtime.start();
    pids = [runtime.registry.resource("open-code-review"), runtime.registry.resource("inari")].map(
      (resource) => resource.mcpClient.transport.pid
    );
    ocrClient = await connectClient(port, "open-code-review");
    inariClient = await connectClient(port, "inari");
    const ocrTools = (await ocrClient.listTools()).tools.map((tool) => tool.name);
    const inariTools = (await inariClient.listTools()).tools.map((tool) => tool.name);
    assert.ok(ocrTools.includes("repo_search"));
    assert.ok(inariTools.includes("inari_template_list"));

    const searched = await ocrClient.callTool({ name: "repo_search", arguments: { query: "majiwari", paths: ["package.json"] } });
    assert.equal(searched.isError, undefined);
    const templates = await inariClient.callTool({ name: "inari_template_list", arguments: {} });
    assert.deepEqual(templates.structuredContent.templates, [{ id: "feature" }]);
    assert.equal((await ocrClient.callTool({ name: "inari_template_list", arguments: {} })).isError, true);

    for (const [client, tool] of [
      [ocrClient, "adapter_health"],
      [inariClient, "adapter_health"]
    ]) {
      const health = await client.callTool({ name: tool, arguments: {} });
      assert.ok(!("repo_root" in health.structuredContent));
      assert.ok(!health.content.some((entry) => String(entry.text ?? "").includes(ROOT)));
    }

    const list = await (await fetch(`http://127.0.0.1:${port}/ui/api/adapters`)).json();
    assert.deepEqual(list.map((adapter) => adapter.id).sort(), ["inari", "open-code-review"]);
    const details = await Promise.all(
      ["open-code-review", "inari"].map(async (id) => (await fetch(`http://127.0.0.1:${port}/ui/api/adapters/${id}`)).json())
    );
    assert.ok(details.every((detail) => !JSON.stringify(detail).includes(ROOT)));
  } finally {
    await ocrClient?.close().catch(() => {});
    await inariClient?.close().catch(() => {});
    await runtime.shutdown();
    for (const pid of pids) await waitForExit(pid);
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("start failure is visible while the healthy sibling and UI remain usable", async () => {
  const port = await getFreePort();
  const failedCalls = {};
  const siblingCalls = {};
  const runtime = createResidentRuntime(config(port), {
    catalog: fixtureCatalog({
      ocr: () => failingManifest("open-code-review", failedCalls),
      inari: () => probeManifest("inari", siblingCalls)
    })
  });
  let client;
  let pid;
  try {
    await runtime.start();
    assert.equal(runtime.registry.get("open-code-review").state, AdapterState.ERRORED);
    assert.equal(runtime.registry.get("inari").state, AdapterState.RUNNING);
    assert.equal((await fetch(`http://127.0.0.1:${port}/ui`)).status, 200);
    const list = await (await fetch(`http://127.0.0.1:${port}/ui/api/adapters`)).json();
    assert.equal(list.find((adapter) => adapter.id === "open-code-review").state, AdapterState.ERRORED);
    client = await connectClient(port, "inari");
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["inari_probe"]);
    pid = runtime.registry.resource("inari").mcpClient.transport.pid;
  } finally {
    await client?.close().catch(() => {});
    await runtime.shutdown();
    if (pid) await waitForExit(pid);
    assert.equal(failedCalls.stopped ?? 0, 0);
    assert.equal(siblingCalls.stopped, 1);
  }
});

test("gateway attach failure leaves the runtime-owned running entry intact", async () => {
  const port = await getFreePort();
  const attachCalls = {};
  const siblingCalls = {};
  const runtime = createResidentRuntime(config(port), {
    catalog: fixtureCatalog({
      ocr: () => nonRoutableManifest("open-code-review", attachCalls),
      inari: () => probeManifest("inari", siblingCalls)
    })
  });
  let pid;
  try {
    await runtime.start();
    const resource = runtime.registry.resource("open-code-review");
    assert.equal(runtime.registry.get("open-code-review").state, AdapterState.RUNNING);
    assert.equal(runtime.registry.resource("open-code-review"), resource);
    assert.ok(runtime.attachFailures.has("open-code-review"));
    assert.equal(await rawGet(port, "/mcp/open-code-review"), 503);
    const list = await (await fetch(`http://127.0.0.1:${port}/ui/api/adapters`)).json();
    assert.equal(list.find((adapter) => adapter.id === "open-code-review").state, AdapterState.RUNNING);
    pid = runtime.registry.resource("inari").mcpClient.transport.pid;
  } finally {
    await runtime.shutdown();
    if (pid) await waitForExit(pid);
    assert.equal(attachCalls.stopped, 1);
    assert.equal(siblingCalls.stopped, 1);
  }
});

test("occupied port fails before adapter acquisition and leaves no resident listener", async () => {
  const port = await getFreePort();
  const occupied = http.createServer();
  await new Promise((resolve) => occupied.listen(port, "127.0.0.1", resolve));
  const calls = {};
  const runtime = createResidentRuntime(config(port, { ocr: false, inari: true }), {
    catalog: {
      inari: () => {
        calls.factory = (calls.factory ?? 0) + 1;
        return probeManifest("inari", calls);
      }
    }
  });

  try {
    await assert.rejects(() => runtime.start(), /EADDRINUSE|address already in use/iu);
    assert.equal(calls.factory ?? 0, 0);
    assert.equal(calls.started ?? 0, 0);
    assert.equal(runtime.server.listening, false);
    assert.equal(runtime.server.listenerCount("request"), 0);
  } finally {
    await runtime.shutdown();
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test("SIGINT/SIGTERM and concurrent shutdown share one cleanup path", async () => {
  const port = await getFreePort();
  const calls = {};
  const runtime = createResidentRuntime(config(port, { ocr: false, inari: true }), {
    catalog: { inari: () => probeManifest("inari", calls) }
  });
  await runtime.start();
  const pid = runtime.registry.resource("inari").mcpClient.transport.pid;
  const processRef = new EventEmitter();
  const exitCodes = [];
  processRef.exit = (code) => exitCodes.push(code);
  const signals = installResidentSignalHandlers(runtime, { processRef, exit: processRef.exit });

  processRef.emit("SIGINT");
  processRef.emit("SIGTERM");
  await signals.promise;
  await Promise.all([runtime.shutdown(), runtime.shutdown()]);
  signals.dispose();

  assert.deepEqual(exitCodes, [0]);
  assert.equal(calls.stopped, 1);
  assert.equal(runtime.state, "stopped");
  assert.equal(runtime.server.listening, false);
  assert.equal(runtime.server.listenerCount("request"), 0);
  await waitForExit(pid);
});

test("the default resident catalog contains only the two trusted adapters", () => {
  assert.deepEqual(Object.keys(TRUSTED_RESIDENT_CATALOG).sort(), ["inari", "open-code-review"]);
});

async function createGitRepo(prefix, content) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "file.txt"), content);
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

/**
 * #29's real end-to-end path: `npm run resident` reads config through the
 * unmodified `TRUSTED_RESIDENT_CATALOG` (no catalog override -- this is
 * exactly what the CLI uses), and the resident config's `targets` shape
 * (`config.js`) switches OCR to managed, target-aware execution
 * (`createManifest({ targetProvider })`, an injected local target provider
 * built from these same targets). One resident process, one OCR adapter
 * entry, published once at `/mcp/open-code-review`; two configured targets
 * are both reachable through it without an adapter restart, and each call
 * only ever sees its own target's content.
 */
test("resident runtime serves two managed OCR targets through /mcp/open-code-review from one adapter, no restart, no cross-talk", async () => {
  const port = await getFreePort();
  const repoA = await createGitRepo("majiwari-resident-target-a-", "hello from target-a\n");
  const repoB = await createGitRepo("majiwari-resident-target-b-", "hello from target-b\n");
  const runtime = createResidentRuntime({
    version: 1,
    port,
    adapters: {
      "open-code-review": {
        enabled: true,
        targets: [
          { id: "target-a", repo: repoA },
          { id: "target-b", repo: repoB }
        ]
      }
    }
  });
  let client;
  try {
    await runtime.start();
    assert.deepEqual(runtime.attachedAdapterIds, ["open-code-review"]);
    assert.equal(runtime.registry.get("open-code-review").state, AdapterState.RUNNING);

    client = await connectClient(port, "open-code-review");

    const readA = await client.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "target-a" } });
    const readB = await client.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "target-b" } });
    assert.equal(readA.structuredContent.content, "hello from target-a\n");
    assert.equal(readB.structuredContent.content, "hello from target-b\n");

    // Same adapter entry, same published endpoint, never restarted between
    // the two targets above.
    assert.equal(runtime.registry.get("open-code-review").state, AdapterState.RUNNING);

    const [concurrentA, concurrentB] = await Promise.all([
      client.callTool({ name: "repo_search", arguments: { query: "target-a", targetId: "target-a" } }),
      client.callTool({ name: "repo_search", arguments: { query: "target-b", targetId: "target-b" } })
    ]);
    assert.match(concurrentA.structuredContent.matches, /target-a/);
    assert.doesNotMatch(concurrentA.structuredContent.matches, /target-b/);
    assert.match(concurrentB.structuredContent.matches, /target-b/);
    assert.doesNotMatch(concurrentB.structuredContent.matches, /target-a/);

    const missingTargetId = await client.callTool({ name: "repo_read_file", arguments: { path: "file.txt" } });
    assert.equal(missingTargetId.isError, true);

    const list = await (await fetch(`http://127.0.0.1:${port}/ui/api/adapters`)).json();
    assert.ok(!JSON.stringify(list).includes(repoA));
    assert.ok(!JSON.stringify(list).includes(repoB));
  } finally {
    await client?.close().catch(() => {});
    await runtime.shutdown();
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  }
});

test("resident config rejects inari 'targets' (single-repository only) before it can leave the adapter running", async () => {
  const port = await getFreePort();
  const runtime = createResidentRuntime({
    version: 1,
    port,
    adapters: { inari: { enabled: true, targets: [{ id: "a", repo: path.resolve(os.tmpdir()) }] } }
  });
  try {
    await assert.rejects(() => runtime.start(), /inari does not support/);
  } finally {
    await runtime.shutdown();
  }
});
