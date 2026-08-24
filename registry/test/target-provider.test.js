import test from "node:test";
import assert from "node:assert/strict";
import {
  InvalidTargetIdError,
  TARGET_PROVIDER_SCHEMA_VERSION,
  TargetProviderError,
  parseTargetId,
  publicTargetSchema,
  resolvedTargetSchema,
  validatePublicTarget,
  validateResolvedTarget,
  validateTargetProviderContract
} from "../src/target-provider.js";

function validContract(overrides = {}) {
  return {
    schemaVersion: TARGET_PROVIDER_SCHEMA_VERSION,
    list: async () => [],
    get: async () => ({}),
    resolve: async () => ({}),
    invalidate: async () => ({}),
    ...overrides
  };
}

test("a valid target-provider contract is accepted", () => {
  const normalized = validateTargetProviderContract(validContract());
  assert.equal(normalized.schemaVersion, TARGET_PROVIDER_SCHEMA_VERSION);
  assert.equal(typeof normalized.list, "function");
  assert.equal(typeof normalized.get, "function");
  assert.equal(typeof normalized.resolve, "function");
  assert.equal(typeof normalized.invalidate, "function");
});

test("a wrong schemaVersion fails deterministically", () => {
  assert.throws(() => validateTargetProviderContract(validContract({ schemaVersion: "2" })), TargetProviderError);
});

test("a missing hook fails deterministically", () => {
  const contract = validContract();
  delete contract.list;
  assert.throws(() => validateTargetProviderContract(contract), /list/);
});

test("a non-function hook fails deterministically", () => {
  assert.throws(() => validateTargetProviderContract(validContract({ resolve: "not-a-function" })), /resolve/);
});

test("an unknown top-level field fails deterministically", () => {
  assert.throws(() => validateTargetProviderContract(validContract({ extra: true })), TargetProviderError);
});

test("target ids accept opaque identifiers", () => {
  assert.equal(parseTargetId("wt-a1"), "wt-a1");
  assert.equal(parseTargetId("Fixture.Target_1"), "Fixture.Target_1");
});

test("target ids reject anything path-shaped", () => {
  for (const bad of ["../../etc/passwd", "/etc/passwd", "a/b", "..", "a\0b", ""]) {
    assert.throws(() => parseTargetId(bad), InvalidTargetIdError, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("publicTargetSchema accepts safe metadata and rejects an internal descriptor", () => {
  const target = validatePublicTarget({ id: "wt-a1", kind: "workspace", displayName: "Repo A", metadata: { branch: "main" } });
  assert.equal(target.id, "wt-a1");

  assert.throws(
    () => validatePublicTarget({ id: "wt-a1", descriptor: { absolutePath: "/srv/repo-a" } }),
    TargetProviderError
  );
});

test("resolvedTargetSchema requires a descriptor and still rejects unknown fields", () => {
  const resolved = validateResolvedTarget({ id: "wt-a1", descriptor: { absolutePath: "/srv/repo-a" } });
  assert.deepEqual(resolved.descriptor, { absolutePath: "/srv/repo-a" });

  assert.throws(() => validateResolvedTarget({ id: "wt-a1", descriptor: {}, unexpected: true }), TargetProviderError);
});

test("public and resolved schemas are distinct types", () => {
  assert.ok(!("descriptor" in publicTargetSchema.shape));
  assert.ok("descriptor" in resolvedTargetSchema.shape);
});
