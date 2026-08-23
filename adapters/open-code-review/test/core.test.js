import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiffArgs,
  buildPreviewArgs,
  buildRuleArgs,
  buildRulesCheckArgs,
  buildScanPreviewArgs,
  parseServerArgs,
  validateRef,
  validateRelativePath
} from "../src/core.js";

test("server args accept an explicit repository", () => {
  assert.deepEqual(parseServerArgs(["--repo", "/tmp/example"]), { repo: "/tmp/example", help: false });
  assert.deepEqual(parseServerArgs(["--help"]), { repo: undefined, help: true });
  assert.throws(() => parseServerArgs(["--repo"]), /requires a path/);
  assert.throws(() => parseServerArgs(["--unknown"]), /unknown argument/);
});

test("preview workspace has only deterministic JSON flags", () => {
  assert.deepEqual(buildPreviewArgs(), ["delegate", "preview", "--format", "json"]);
});

test("preview range requires both refs", () => {
  assert.throws(() => buildPreviewArgs({ from: "main" }), /both from and to/);
  assert.deepEqual(buildPreviewArgs({ from: "main", to: "feature/x" }), [
    "delegate", "preview", "--format", "json", "--from", "main", "--to", "feature/x"
  ]);
});

test("preview commit excludes range", () => {
  assert.throws(() => buildPreviewArgs({ commit: "abc123", from: "main", to: "HEAD" }), /cannot be combined/);
});

test("unsafe refs are rejected", () => {
  assert.throws(() => validateRef("--help"), /unsafe/);
  assert.throws(() => validateRef("main\n--help"), /unsafe/);
});

test("paths cannot escape repo", () => {
  assert.throws(() => validateRelativePath("../secret"), /escapes/);
  assert.throws(() => validateRelativePath("/etc/passwd"), /repository-relative/);
});

test("rule args preserve OCR as rule authority", () => {
  assert.deepEqual(buildRuleArgs(["src/a.ts", "src/b.ts"]), [
    "delegate", "rule", "--format", "json", "src/a.ts", "src/b.ts"
  ]);
});

test("range diff uses merge base supplied by OCR", () => {
  assert.deepEqual(
    buildDiffArgs({ mode: "range", filePath: "src/a.ts", mergeBase: "abc123", to: "feature/x" }),
    { command: "git", args: ["diff", "abc123..feature/x", "--", "src/a.ts"], kind: "diff" }
  );
});

test("scan preview defaults to whole repository", () => {
  assert.deepEqual(buildScanPreviewArgs(), ["scan", "--preview", "--format", "json"]);
});

test("scan preview accepts comma-separated paths", () => {
  assert.deepEqual(buildScanPreviewArgs({ path: "src/a.ts, src/b.ts" }), [
    "scan", "--preview", "--format", "json", "--path", "src/a.ts,src/b.ts"
  ]);
});

test("scan preview rejects unsafe paths", () => {
  assert.throws(() => buildScanPreviewArgs({ path: "../secret" }), /escapes/);
});

test("rules check args preserve OCR as rule authority", () => {
  assert.deepEqual(buildRulesCheckArgs("src/a.ts"), ["rules", "check", "src/a.ts"]);
  assert.deepEqual(buildRulesCheckArgs("src/a.ts", "custom.json"), [
    "rules", "check", "--rule", "custom.json", "src/a.ts"
  ]);
});

test("workspace untracked reads whole file", () => {
  assert.deepEqual(
    buildDiffArgs({ mode: "workspace", filePath: "src/new.ts", workspaceSource: "untracked" }),
    { command: null, args: [], kind: "file", path: "src/new.ts" }
  );
});
