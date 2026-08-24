import test from "node:test";
import assert from "node:assert/strict";
import { AdapterManifestError, MANIFEST_SCHEMA_VERSION, validateManifest } from "../src/manifest.js";

function validStdioManifest(overrides = {}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: "fixture-a",
    version: "1.0.0",
    transport: { kind: "stdio", start: async () => ({}) },
    ...overrides
  };
}

test("a valid stdio manifest normalizes and round-trips", () => {
  const normalized = validateManifest(validStdioManifest());
  assert.equal(normalized.id, "fixture-a");
  assert.equal(normalized.version, "1.0.0");
  assert.equal(normalized.transport.kind, "stdio");
});

test("a valid endpoint manifest is accepted", () => {
  const normalized = validateManifest(
    validStdioManifest({ transport: { kind: "endpoint", url: "https://adapter.example/mcp" } })
  );
  assert.equal(normalized.transport.kind, "endpoint");
  assert.equal(normalized.transport.url, "https://adapter.example/mcp");
});

test("optional capabilities and discovery hooks are accepted as metadata", () => {
  const normalized = validateManifest(
    validStdioManifest({
      capabilities: ["target-provider", "ui"],
      health: async () => ({ ok: true }),
      listTools: async () => []
    })
  );
  assert.deepEqual(normalized.capabilities, ["target-provider", "ui"]);
  assert.equal(typeof normalized.health, "function");
  assert.equal(typeof normalized.listTools, "function");
});

test("a wrong schemaVersion fails deterministically", () => {
  assert.throws(() => validateManifest(validStdioManifest({ schemaVersion: "2" })), AdapterManifestError);
});

test("a missing id fails deterministically", () => {
  const manifest = validStdioManifest();
  delete manifest.id;
  assert.throws(() => validateManifest(manifest), /id/);
});

test("an id with disallowed characters fails deterministically", () => {
  assert.throws(() => validateManifest(validStdioManifest({ id: "Fixture_A" })), /id/);
});

test("a non-semver version fails deterministically", () => {
  assert.throws(() => validateManifest(validStdioManifest({ version: "v1" })), /version/);
});

test("an unknown top-level field fails deterministically", () => {
  assert.throws(() => validateManifest(validStdioManifest({ unexpected: true })), AdapterManifestError);
});

test("an unknown transport kind fails deterministically", () => {
  assert.throws(() => validateManifest(validStdioManifest({ transport: { kind: "http" } })), AdapterManifestError);
});

test("stdio transport requires a start() function", () => {
  assert.throws(() => validateManifest(validStdioManifest({ transport: { kind: "stdio" } })), /start/);
  assert.throws(
    () => validateManifest(validStdioManifest({ transport: { kind: "stdio", start: "not-a-function" } })),
    /start/
  );
});

test("endpoint transport requires a non-empty url", () => {
  assert.throws(
    () => validateManifest(validStdioManifest({ transport: { kind: "endpoint", url: "" } })),
    /url/
  );
});

test("a non-function health/listTools fails deterministically", () => {
  assert.throws(() => validateManifest(validStdioManifest({ health: "no" })), /health/);
  assert.throws(() => validateManifest(validStdioManifest({ listTools: 42 })), /listTools/);
});
