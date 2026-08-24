import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "@majiwari/registry";
import { createUiServer } from "../src/server.js";
import { createFailingFixtureManifest, createFixtureManifest } from "./fixtures/fixture-adapter.js";

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
  await registry.start("fixture-a");

  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/api/adapters`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const byId = Object.fromEntries(body.map((adapter) => [adapter.id, adapter]));
    assert.equal(byId["fixture-a"].state, "running");
    assert.equal(byId["fixture-b"].state, "registered");
  });
});

test("adding a third, differently-named fixture adapter shows up with no server code change", async () => {
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

test("GET /api/adapters/:id returns identity, health, tools, and capabilities", async () => {
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
    assert.deepEqual(body.tools, [{ name: "fixture-a_tool" }]);
    assert.equal(body.health.ok, true);
  });
});

test("GET /api/adapters/:id on an unknown id returns 404 with an error body", async () => {
  const registry = new AdapterRegistry();
  registry.register(createFixtureManifest("fixture-a"));

  await withServer(registry, async (base) => {
    const response = await fetch(`${base}/api/adapters/does-not-exist`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.match(body.error, /does-not-exist/);
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
