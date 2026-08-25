import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildFieldArgs,
  buildGetArgs,
  buildIssueCreateArgs,
  buildPullRequestCreateArgs,
  buildTemplateSchemaArgs,
  buildValidateArgs,
  checkAdapterHealth,
  EXPECTED_INARI_NAME,
  EXPECTED_INARI_PROTOCOL,
  MINIMUM_INARI_VERSION,
  parseJson,
  parseServerArgs,
  runInari,
  validateArtifactNumber,
  validateToken,
  versionAtLeast
} from "../src/core.js";

test("server args accept an explicit repository", () => {
  assert.deepEqual(parseServerArgs(["--repo", "/tmp/example"]), { repo: "/tmp/example", help: false });
  assert.deepEqual(parseServerArgs(["--help"]), { repo: undefined, help: true });
  assert.throws(() => parseServerArgs(["--repo"]), /requires a path/);
  assert.throws(() => parseServerArgs(["--unknown"]), /unknown argument/);
});

test("unsafe tokens are rejected", () => {
  assert.throws(() => validateToken("--help"), /unsafe/);
  assert.throws(() => validateToken("main\n--help"), /unsafe/);
  assert.throws(() => validateToken(""), /non-empty/);
  assert.equal(validateToken("feature"), "feature");
});

test("artifact numbers must be positive integers", () => {
  assert.equal(validateArtifactNumber(42), 42);
  assert.equal(validateArtifactNumber("42"), 42);
  assert.throws(() => validateArtifactNumber(0), /positive integer/);
  assert.throws(() => validateArtifactNumber("abc"), /positive integer/);
  assert.throws(() => validateArtifactNumber(-1), /positive integer/);
});

test("field args are built deterministically and reject unsafe names", () => {
  assert.deepEqual(buildFieldArgs({ summary: "A reproducible defect" }), ["--field", "summary=A reproducible defect"]);
  assert.deepEqual(buildFieldArgs({ labels: ["bug", "p1"] }), ["--field", "labels=bug", "--field", "labels=p1"]);
  assert.deepEqual(buildFieldArgs(undefined), []);
  assert.throws(() => buildFieldArgs({ "bad name": "x" }), /must match/);
  assert.throws(() => buildFieldArgs({ ok: "has\0nul" }), /NUL bytes/);
});

test("field args reject more than the maximum allowed entries", () => {
  const fields = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, "v"]));
  assert.throws(() => buildFieldArgs(fields), /at most 200/);
});

test("template schema args are positional with --json", () => {
  assert.deepEqual(buildTemplateSchemaArgs("issue", "feature"), ["issue", "schema", "feature", "--json"]);
  assert.deepEqual(buildTemplateSchemaArgs("pr", "default", { compact: true }), ["pr", "schema", "default", "--json", "--compact"]);
});

test("get args use --template only when provided", () => {
  assert.deepEqual(buildGetArgs("issue", 12), ["issue", "get", "12", "--json"]);
  assert.deepEqual(buildGetArgs("pr", 12, "default"), ["pr", "get", "12", "--json", "--template", "default"]);
});

test("validate args select existing-artifact mode from a number", () => {
  assert.deepEqual(buildValidateArgs("issue", { number: 7 }), ["issue", "validate", "7", "--json"]);
  assert.deepEqual(buildValidateArgs("pr", { number: 7, template: "default" }), [
    "pr", "validate", "7", "--json", "--template", "default"
  ]);
});

test("validate args select new-content mode from a template", () => {
  assert.deepEqual(buildValidateArgs("issue", { template: "feature", fields: { summary: "x" } }), [
    "issue", "validate", "--template", "feature", "--field", "summary=x", "--json"
  ]);
});

test("validate args require a template when no number is given", () => {
  assert.throws(() => buildValidateArgs("issue", {}), /template is required/);
});

test("issue create args carry template, fields, and optional title", () => {
  assert.deepEqual(buildIssueCreateArgs("feature", { summary: "x" }, { title: "fix: y" }), [
    "issue", "create", "--template", "feature", "--field", "summary=x", "--json", "--title", "fix: y"
  ]);
});

test("pr create args carry head/base/draft/maintainer-can-modify", () => {
  assert.deepEqual(
    buildPullRequestCreateArgs("default", { summary: "x" }, { head: "feature/a", base: "main", draft: true, maintainerCanModify: false }),
    [
      "pr", "create", "--template", "default", "--field", "summary=x", "--json",
      "--head", "feature/a", "--base", "main", "--draft=true", "--maintainer-can-modify=false"
    ]
  );
});

test("parseJson raises a labeled error on invalid JSON", () => {
  assert.throws(() => parseJson("not json", "inari issue get"), /did not return valid JSON/);
  assert.deepEqual(parseJson('{"ok":true}', "label"), { ok: true });
});

test("runInari invokes the configured inari binary and parses its JSON stdout", async () => {
  const fixturesDir = await mkdtemp(path.join(tmpdir(), "inari-fixture-"));
  const scriptPath = path.join(fixturesDir, "inari");
  await writeFile(
    scriptPath,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, argv: process.argv.slice(2) }));\n"
  );
  await chmod(scriptPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fixturesDir}:${originalPath}`;
  try {
    const data = await runInari(["issue", "schema", "feature", "--json"], { cwd: fixturesDir, label: "inari issue schema" });
    assert.equal(data.ok, true);
    assert.deepEqual(data.argv, ["issue", "schema", "feature", "--json"]);
  } finally {
    process.env.PATH = originalPath;
    await rm(fixturesDir, { recursive: true, force: true });
  }
});

test("versionAtLeast compares major.minor.patch deterministically", () => {
  assert.equal(versionAtLeast("0.8.0", "0.8.0"), true);
  assert.equal(versionAtLeast("0.8.1", "0.8.0"), true);
  assert.equal(versionAtLeast("1.0.0", "0.8.0"), true);
  assert.equal(versionAtLeast("0.7.9", "0.8.0"), false);
  assert.equal(versionAtLeast("not-a-version", "0.8.0"), false);
  assert.equal(versionAtLeast(undefined, "0.8.0"), false);
});

/**
 * Fake `inari`/`gh` binaries on PATH, so `checkAdapterHealth()`'s compatibility
 * decision (name/protocol/version match, GitHub auth) can be asserted without
 * depending on the real `gh-inari` CLI being installed wherever this suite runs.
 */
async function withFakeBinaries({ inari, gh = "#!/bin/sh\nexit 0\n" }, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "inari-adapter-fake-"));
  const inariPath = path.join(dir, "inari");
  const ghPath = path.join(dir, "gh");
  await writeFile(inariPath, inari);
  await writeFile(ghPath, gh);
  await chmod(inariPath, 0o755);
  await chmod(ghPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  try {
    return await fn(dir);
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeInariScript({ name = EXPECTED_INARI_NAME, protocol = EXPECTED_INARI_PROTOCOL, version = MINIMUM_INARI_VERSION } = {}) {
  const payload = JSON.stringify({ ok: true, name, version, protocol, capabilities: [] });
  return `#!/bin/sh\necho '${payload}'\n`;
}

test("checkAdapterHealth reports ok when inari's name/protocol/version and gh auth all match", async () => {
  await withFakeBinaries({ inari: fakeInariScript() }, async (dir) => {
    const health = await checkAdapterHealth(dir);
    assert.equal(health.ok, true);
    assert.equal(health.inari_compatible, true);
    assert.equal(health.github_authenticated, true);
    assert.equal(health.detail, undefined);
  });
});

test("checkAdapterHealth fails clearly on a protocol mismatch", async () => {
  await withFakeBinaries({ inari: fakeInariScript({ protocol: 2 }) }, async (dir) => {
    const health = await checkAdapterHealth(dir);
    assert.equal(health.ok, false);
    assert.equal(health.inari_compatible, false);
    assert.match(health.detail, /protocol/);
  });
});

test("checkAdapterHealth fails clearly on an installed version older than the minimum supported", async () => {
  await withFakeBinaries({ inari: fakeInariScript({ version: "0.1.0" }) }, async (dir) => {
    const health = await checkAdapterHealth(dir);
    assert.equal(health.ok, false);
    assert.equal(health.inari_compatible, false);
    assert.match(health.detail, /older than the minimum supported version/);
  });
});

test("checkAdapterHealth fails clearly when gh reports no authenticated account", async () => {
  await withFakeBinaries({ inari: fakeInariScript(), gh: "#!/bin/sh\nexit 1\n" }, async (dir) => {
    const health = await checkAdapterHealth(dir);
    assert.equal(health.ok, false);
    assert.equal(health.inari_compatible, true);
    assert.equal(health.github_authenticated, false);
    assert.match(health.detail, /not report an authenticated account/);
  });
});
