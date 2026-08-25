import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AdapterRegistry } from "@majiwari/registry";
import { createUiHandler, createUiServer } from "../src/server.js";
import {
  createFailingFixtureManifest,
  createFixtureManifest,
  createFixtureTargetProvider,
  createHealthFailureFixtureManifest,
  createToolDiscoveryFailureFixtureManifest
} from "./fixtures/fixture-adapter.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function withServer(registry, run) {
  const server = createUiServer(registry);
  const base = await listen(server);
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /api/adapters lists every registered fixture adapter with current status", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));
  registry.register(createFixtureManifest("fixture-b"));
  registry.register(createFixtureManifest("fixture-c"));
  await registry.start("fixture-a");

  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/api/adapters`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const byId = Object.fromEntries(body.map((adapter) => [adapter.id, adapter]));
    assert.equal(byId["fixture-a"].state, "running");
    assert.equal(byId["fixture-b"].state, "registered");
    assert.equal(byId["fixture-c"].state, "registered");
  });
});

test("adding a fourth, differently-named fixture adapter shows up with no server code change", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));
  registry.register(createFixtureManifest("totally-different-adapter-id"));

  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/api/adapters`);
    const body = await response.json();
    const ids = body.map((adapter) => adapter.id).sort();
    assert.deepEqual(ids, ["fixture-a", "totally-different-adapter-id"]);
  });
});

test("GET /api/adapters/:id returns identity, health, tools, capabilities, and targets through the canonical registry API", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));
  await registry.start("fixture-a");

  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/api/adapters/fixture-a`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, "fixture-a");
    assert.equal(body.version, "1.0.0");
    assert.deepEqual(body.capabilities, ["fixture"]);
    assert.deepEqual(body.tools, { ok: true, items: [{ name: "fixture-a_tool" }] });
    assert.equal(body.health.ok, true);
    assert.deepEqual(body.targets, { supported: false, ok: true, items: [] });
  });
});

test("an adapter without optional capabilities still renders a complete, non-error detail", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-bare", { listTools: undefined, health: undefined, capabilities: undefined }));
  await registry.start("fixture-bare");

  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/api/adapters/fixture-bare`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.capabilities, []);
    assert.deepEqual(body.tools, { ok: true, items: [] });
    assert.equal(body.health.ok, true);
    assert.deepEqual(body.targets, { supported: false, ok: true, items: [] });
  });
});

test("GET /api/adapters/:id on an unknown id returns 404 with a bounded error body and no internal detail", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));

  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/api/adapters/does-not-exist`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.match(body.error, /does-not-exist/);
    assert.deepEqual(Object.keys(body), ["error"]);
  });
});

test("a failed adapter's state is visible over the API without breaking a healthy sibling's detail view", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-healthy"));
  registry.register(createFailingFixtureManifest("fixture-broken", "spawn failed"));
  await registry.start("fixture-healthy");
  await registry.start("fixture-broken");

  await withServer(registry, async (base) => {
    const listResponse = await fetch(`${base}/api/adapters`);
    const list = await listResponse.json();
    const broken = list.find((adapter) => adapter.id === "fixture-broken");
    assert.equal(broken.state, "errored");
    assert.equal(broken.error, "spawn failed");

    const healthyDetail = await fetch(`${base}/api/adapters/fixture-healthy`);
    assert.equal(healthyDetail.status, 200);
    assert.equal((await healthyDetail.json()).state, "running");
  });
});

test("a stopped adapter's state is represented accurately over the API", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));
  await registry.start("fixture-a");
  await registry.stop("fixture-a");

  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/api/adapters/fixture-a`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.state, "stopped");
    assert.ok(body.stoppedAt);
  });
});

test("a tool-discovery failure is isolated to its own adapter's detail and never breaks listing or a sibling", async () => {
  const registry = new AdapterRegistry();
  registry.register(createToolDiscoveryFailureFixtureManifest("fixture-tools-broken", "listTools boom"));
  registry.register(createFixtureManifest("fixture-sibling"));
  await registry.start("fixture-tools-broken");
  await registry.start("fixture-sibling");

  await withServer(registry, async (base) => {
    const listResponse = await fetch(`${base}/api/adapters`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.deepEqual(
      list.map((adapter) => adapter.id).sort(),
      ["fixture-sibling", "fixture-tools-broken"]
    );

    const brokenDetail = await fetch(`${base}/api/adapters/fixture-tools-broken`);
    assert.equal(brokenDetail.status, 200);
    const brokenBody = await brokenDetail.json();
    assert.equal(brokenBody.tools.ok, false);
    assert.match(brokenBody.tools.error, /listTools boom/);
    assert.equal(brokenBody.health.ok, true);

    const siblingDetail = await fetch(`${base}/api/adapters/fixture-sibling`);
    assert.equal(siblingDetail.status, 200);
    assert.equal((await siblingDetail.json()).tools.ok, true);
  });
});

test("a health failure is isolated to its own adapter's detail and never breaks listing or a sibling", async () => {
  const registry = new AdapterRegistry();
  registry.register(createHealthFailureFixtureManifest("fixture-health-broken", "health boom"));
  registry.register(createFixtureManifest("fixture-sibling"));
  await registry.start("fixture-health-broken");
  await registry.start("fixture-sibling");

  await withServer(registry, async (base) => {
    const brokenDetail = await fetch(`${base}/api/adapters/fixture-health-broken`);
    assert.equal(brokenDetail.status, 200);
    const brokenBody = await brokenDetail.json();
    assert.equal(brokenBody.health.ok, false);
    assert.match(brokenBody.health.error, /health boom/);
    assert.deepEqual(brokenBody.tools, { ok: true, items: [] });

    const siblingDetail = await fetch(`${base}/api/adapters/fixture-sibling`);
    assert.equal((await siblingDetail.json()).health.ok, true);
  });
});

test("the generic target-provider projection is served without exposing a resolved/internal descriptor", async () => {
  const registry = new AdapterRegistry();
  const provider = createFixtureTargetProvider();
  registry.register(createFixtureManifest("fixture-targets", { targetProvider: provider }));
  await registry.start("fixture-targets");

  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/api/adapters/fixture-targets`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.targets.supported, true);
    assert.equal(body.targets.ok, true);
    assert.deepEqual(body.targets.items, [{ id: "target-a", kind: "fixture-target", displayName: "Target A" }]);
    const serialized = JSON.stringify(body.targets);
    assert.ok(!serialized.includes("descriptor"), "response body must never carry a resolved target's internal descriptor");
  });
});

test("a target-provider failure is isolated to its own adapter's detail and never breaks listing or a sibling", async () => {
  const registry = new AdapterRegistry();
  const provider = createFixtureTargetProvider({
    list: async () => {
      throw new Error("target discovery boom");
    }
  });
  registry.register(createFixtureManifest("fixture-targets-broken", { targetProvider: provider }));
  registry.register(createFixtureManifest("fixture-sibling"));
  await registry.start("fixture-targets-broken");
  await registry.start("fixture-sibling");

  await withServer(registry, async (base) => {
    const listResponse = await fetch(`${base}/api/adapters`);
    assert.equal(listResponse.status, 200);

    const brokenDetail = await fetch(`${base}/api/adapters/fixture-targets-broken`);
    assert.equal(brokenDetail.status, 200);
    const brokenBody = await brokenDetail.json();
    assert.equal(brokenBody.targets.supported, true);
    assert.equal(brokenBody.targets.ok, false);
    assert.match(brokenBody.targets.error, /target discovery boom/);
    assert.equal(brokenBody.health.ok, true);

    const siblingDetail = await fetch(`${base}/api/adapters/fixture-sibling`);
    assert.equal(siblingDetail.status, 200);
    assert.deepEqual((await siblingDetail.json()).targets, { supported: false, ok: true, items: [] });
  });
});

test("serves the static shell", async () => {
  const registry = new AdapterRegistry();
  await withServer(registry, async (base) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    assert.match(await index.text(), /Majiwari/);

    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
  });
});

test("an unmatched route returns 404", async () => {
  const registry = new AdapterRegistry();
  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/does-not-exist`);
    assert.equal(response.status, 404);
  });
});

test("the UI handler mounts under /ui on an external ingress and fails closed for malformed ids", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-mounted"));
  const handler = createUiHandler(registry, { basePath: "/ui" });
  const ingress = http.createServer(async (req, res) => {
    if (!(await handler(req, res))) sendFallbackNotFound(res);
  });

  function sendFallbackNotFound(res) {
    res.writeHead(404).end();
  }

  const base = await listen(ingress);
  try {
    const index = await fetch(`${base}/ui`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /\/ui\/app\.js/);

    const list = await fetch(`${base}/ui/api/adapters`);
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).map((adapter) => adapter.id), ["fixture-mounted"]);

    const malformed = await fetch(`${base}/ui/api/adapters/%zz`);
    assert.equal(malformed.status, 404);
    assert.equal((await fetch(`${base}/mcp/fixture-mounted`)).status, 404);
  } finally {
    await new Promise((resolve) => ingress.close(resolve));
  }
});
