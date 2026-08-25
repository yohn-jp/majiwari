import test from "node:test";
import assert from "node:assert/strict";
import { toGatewayRoutableResource } from "../src/gateway-transport.js";

test("toGatewayRoutableResource accepts any plain object satisfying the documented contract, not only a stdio-target.js-produced handle", () => {
  const fakeClient = { request: async () => {} };
  const resource = toGatewayRoutableResource(
    { mcpClient: fakeClient, serverCapabilities: { tools: {} }, serverVersion: { name: "fixture", version: "1.0.0" } },
    "fixture-a"
  );
  assert.equal(resource.mcpClient, fakeClient);
});

test("toGatewayRoutableResource rejects the old implicit .client shape instead of silently accepting it", () => {
  assert.throws(
    () => toGatewayRoutableResource({ client: {}, serverCapabilities: {}, serverVersion: {} }, "fixture-a"),
    /gateway-routable transport contract/
  );
});

test("toGatewayRoutableResource rejects a handle missing serverVersion/serverCapabilities", () => {
  const mcpClient = { request: async () => {} };
  assert.throws(() => toGatewayRoutableResource({ mcpClient }, "fixture-a"), /serverVersion/);
  assert.throws(() => toGatewayRoutableResource({ mcpClient, serverVersion: {} }, "fixture-a"), /serverCapabilities/);
});

test("toGatewayRoutableResource rejects a missing resource with an adapter-identified message", () => {
  assert.throws(() => toGatewayRoutableResource(undefined, "fixture-a"), /fixture-a/);
});
