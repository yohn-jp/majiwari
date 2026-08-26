import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AdapterRegistry, AdapterState, TargetNotFoundError, TargetUnavailableError } from "@majiwari/registry";
import { ADAPTER_ID, createManifest } from "../src/manifest.js";
import { createMottainaiTargetProvider, MottainaiTargetProviderError } from "../src/mottainai-target-provider.js";

const execFileAsync = promisify(execFile);

function ok(payload) {
  return { stdout: JSON.stringify(payload), exitCode: 0 };
}

function fail(exitCode = 1) {
  return { stdout: "", exitCode };
}

/**
 * Deterministic fake for the injectable `run` seam
 * (`mottainai-target-provider.js`'s `run` option): dispatches on the
 * `task list`/`task status --task-id <id>` shape of the real #539 CLI
 * contract without spawning any subprocess. `listResponse`/`statusResponses`
 * may be plain values or zero-arg functions (so a test can mutate what the
 * "CLI" would return between two provider calls -- e.g. to simulate
 * disappearance between list() and resolve()).
 */
function createFakeRun({ listResponse = ok([]), statusResponses = new Map() } = {}) {
  const calls = { total: 0, list: 0, status: 0, statusIds: [] };
  const run = async (args) => {
    calls.total += 1;
    if (args[0] === "task" && args[1] === "list") {
      calls.list += 1;
      return typeof listResponse === "function" ? listResponse() : listResponse;
    }
    if (args[0] === "task" && args[1] === "status") {
      calls.status += 1;
      const id = args[args.indexOf("--task-id") + 1];
      calls.statusIds.push(id);
      const responder = statusResponses.get(id);
      if (!responder) return fail(1);
      return typeof responder === "function" ? responder() : responder;
    }
    throw new Error(`fake mottainai run: unexpected invocation ${JSON.stringify(args)}`);
  };
  return { run, calls };
}

function taskEntry(overrides = {}) {
  return {
    taskId: "task-a",
    repository: "yohn-jp/majiwari",
    branchName: "feat/example",
    headCommit: "a".repeat(40),
    lifecycleState: "active",
    runtimeState: "running",
    ...overrides
  };
}

test("list() discovers candidate targets across at least two repositories/tasks with opaque ids and public-safe metadata", async () => {
  const { run } = createFakeRun({
    listResponse: ok([
      taskEntry({ taskId: "task-a", repository: "yohn-jp/majiwari", branchName: "feat/a" }),
      taskEntry({ taskId: "task-b", repository: "yohn-jp/mottainai", branchName: "feat/b", headCommit: "b".repeat(40) })
    ])
  });
  const provider = createMottainaiTargetProvider({ run });

  const listed = await provider.list();
  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map((t) => t.id).sort(),
    ["task-a", "task-b"]
  );
  for (const target of listed) {
    assert.match(target.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.ok(!("descriptor" in target), "list() must never return a resolved descriptor");
    // "yohn-jp/majiwari"-style repository identity legitimately contains a
    // "/", so this checks specifically for an absolute-path-shaped value
    // (leading "/") rather than forbidding "/" outright.
    for (const value of Object.values(target.metadata ?? {})) {
      if (typeof value === "string") assert.ok(!value.startsWith("/"), `metadata value must not be an absolute path: ${value}`);
    }
  }
  const byId = Object.fromEntries(listed.map((t) => [t.id, t]));
  assert.equal(byId["task-a"].metadata.repository, "yohn-jp/majiwari");
  assert.equal(byId["task-b"].metadata.repository, "yohn-jp/mottainai");
  assert.equal(byId["task-a"].metadata.availability, "available");
});

test("empty discovery snapshot is a valid success, distinct from a provider failure", async () => {
  const { run } = createFakeRun({ listResponse: ok([]) });
  const provider = createMottainaiTargetProvider({ run });
  assert.deepEqual(await provider.list(), []);
});

test("mottainai command/process failure surfaces as a bounded error, never a false empty list", async () => {
  const { run } = createFakeRun({ listResponse: fail(2) });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.list(), MottainaiTargetProviderError);
});

test("a binary that cannot even be spawned surfaces as a bounded error", async () => {
  const run = async () => {
    const error = new Error("spawn mottainai ENOENT");
    error.errno = -2;
    error.code = "ENOENT";
    throw error;
  };
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.list(), MottainaiTargetProviderError);
});

test("malformed/incompatible mottainai output fails closed instead of being trusted", async () => {
  const malformedPayloads = [
    "not json at all",
    JSON.stringify({ not: "an array" }),
    JSON.stringify([{ taskId: "task-a" }]), // missing required fields
    JSON.stringify([{ ...taskEntry(), worktreePath: "/should/not/appear/in/list/output" }]), // list must never carry a worktree path
    JSON.stringify([{ ...taskEntry(), extraUnknownField: "nope" }]) // unrecognized field
  ];
  for (const stdout of malformedPayloads) {
    const { run } = createFakeRun({ listResponse: { stdout, exitCode: 0 } });
    const provider = createMottainaiTargetProvider({ run });
    await assert.rejects(() => provider.list(), MottainaiTargetProviderError, `expected rejection for: ${stdout}`);
  }
});

test("resolve() performs a fresh call every time and is never served from a cached list() snapshot", async () => {
  let worktree = "/tmp/mottainai-worktree-v1";
  const statusResponses = new Map([["task-a", () => ok({ ...taskEntry(), worktreePath: worktree })]]);
  const { run, calls } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });

  const first = await provider.resolve("task-a");
  assert.equal(first.descriptor.repoRoot, worktree);

  worktree = "/tmp/mottainai-worktree-v2";
  const second = await provider.resolve("task-a");
  assert.equal(second.descriptor.repoRoot, worktree);
  assert.equal(calls.status, 2, "each resolve() call must hit mottainai again, never a cache");
});

test("get() also resolves fresh availability rather than trusting a stale list snapshot", async () => {
  const statusResponses = new Map([["task-a", () => ok(taskEntry({ lifecycleState: "closed", runtimeState: "stopped" }))]]);
  const { run } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.get("task-a"), TargetUnavailableError);
});

test("target disappearance between list() and resolve() fails closed as not-found (TOCTOU)", async () => {
  const listResponse = ok([taskEntry({ taskId: "task-a" })]);
  // No entry for "task-a" in statusResponses simulates it disappearing by
  // the time status is asked -- fetchStatus's fake `mottainai` exits
  // non-zero, matching the real CLI's behavior for a task-id it can no
  // longer resolve.
  const { run } = createFakeRun({ listResponse, statusResponses: new Map() });
  const provider = createMottainaiTargetProvider({ run });

  const listed = await provider.list();
  assert.equal(listed[0].id, "task-a");

  await assert.rejects(() => provider.resolve("task-a"), TargetNotFoundError);
  await assert.rejects(() => provider.get("task-a"), TargetNotFoundError);
});

test("a closed/discarded task known to mottainai resolves as unavailable, not not-found", async () => {
  const statusResponses = new Map([["task-a", () => ok(taskEntry({ lifecycleState: "closed", runtimeState: "stopped" }))]]);
  const { run } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.resolve("task-a"), TargetUnavailableError);
});

test("resolve() fails closed when mottainai reports available but omits the worktree path", async () => {
  const statusResponses = new Map([["task-a", () => ok(taskEntry())]]); // no worktreePath
  const { run } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.resolve("task-a"), TargetUnavailableError);
});

test("malformed status output fails closed as a bounded provider error, not a silent unavailability", async () => {
  const statusResponses = new Map([["task-a", () => ({ stdout: "{not valid json", exitCode: 0 })]]);
  const { run } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.resolve("task-a"), MottainaiTargetProviderError);
});

test("invalidate() makes one target deterministically unavailable while an unrelated target stays usable", async () => {
  const statusResponses = new Map([
    ["task-a", () => ok({ ...taskEntry({ taskId: "task-a" }), worktreePath: "/tmp/a" })],
    ["task-b", () => ok({ ...taskEntry({ taskId: "task-b" }), worktreePath: "/tmp/b" })]
  ]);
  const { run } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });

  await provider.invalidate("task-a");
  await assert.rejects(() => provider.resolve("task-a"), TargetUnavailableError);
  await assert.rejects(() => provider.get("task-a"), TargetUnavailableError);

  const stillGood = await provider.resolve("task-b");
  assert.equal(stillGood.descriptor.repoRoot, "/tmp/b");
});

test("no configured/resolved absolute path ever appears in a thrown error's message", async () => {
  const secretPath = "/abs/secret/mottainai-worktree-should-not-leak";
  const scenarios = [
    () => createFakeRun({ listResponse: fail(1) }),
    () => createFakeRun({ listResponse: { stdout: `not json, but mentions ${secretPath}`, exitCode: 0 } }),
    () =>
      createFakeRun({
        statusResponses: new Map([["task-a", () => ({ stdout: `garbage referencing ${secretPath}`, exitCode: 0 })]])
      })
  ];
  for (const build of scenarios) {
    const { run } = build();
    const provider = createMottainaiTargetProvider({ run });
    try {
      await provider.list();
      await provider.resolve("task-a");
      assert.fail("expected a rejection");
    } catch (error) {
      assert.ok(!error.message.includes(secretPath), `error message must not embed: ${error.message}`);
      assert.ok(!error.message.includes("garbage") && !error.message.includes("not json"), "error message must not embed raw command output");
    }
  }
});

// --- End-to-end through the same #29 execution path OCR uses -----------

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

async function withTwoTargetRepos(fn) {
  const a = await createGitRepo("mottainai-target-a-", "hello from mottainai target-a\n");
  const b = await createGitRepo("mottainai-target-b-", "hello from mottainai target-b\n");
  try {
    await fn(a, b);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
}

async function startManaged(provider) {
  const registry = new AdapterRegistry();
  registry.register(createManifest({ targetProvider: provider }));
  const status = await registry.start(ADAPTER_ID);
  assert.equal(status.state, AdapterState.RUNNING, status.error);
  return { registry, mcpClient: registry.resource(ADAPTER_ID).mcpClient };
}

test("#29 OCR execution resolves the correct canonical worktree for a Mottainai-managed target, across two repos, with no cross-talk", async () => {
  await withTwoTargetRepos(async (repoA, repoB) => {
    const statusResponses = new Map([
      ["task-a", () => ok({ ...taskEntry({ taskId: "task-a", repository: "yohn-jp/repo-a" }), worktreePath: repoA })],
      ["task-b", () => ok({ ...taskEntry({ taskId: "task-b", repository: "yohn-jp/repo-b" }), worktreePath: repoB })]
    ]);
    const { run } = createFakeRun({
      listResponse: ok([taskEntry({ taskId: "task-a", repository: "yohn-jp/repo-a" }), taskEntry({ taskId: "task-b", repository: "yohn-jp/repo-b" })]),
      statusResponses
    });
    const provider = createMottainaiTargetProvider({ run });
    const { registry, mcpClient } = await startManaged(provider);
    try {
      const readA = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "task-a" } });
      const readB = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "task-b" } });
      assert.equal(readA.structuredContent.content, "hello from mottainai target-a\n");
      assert.equal(readB.structuredContent.content, "hello from mottainai target-b\n");
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

test("interleaved/concurrent Mottainai-managed targets never cross-talk", async () => {
  await withTwoTargetRepos(async (repoA, repoB) => {
    const statusResponses = new Map([
      ["task-a", () => ok({ ...taskEntry({ taskId: "task-a" }), worktreePath: repoA })],
      ["task-b", () => ok({ ...taskEntry({ taskId: "task-b" }), worktreePath: repoB })]
    ]);
    const { run } = createFakeRun({ statusResponses });
    const provider = createMottainaiTargetProvider({ run });
    const { registry, mcpClient } = await startManaged(provider);

    async function workflow(targetId, expectedSnippet) {
      const search = await mcpClient.callTool({ name: "repo_search", arguments: { query: expectedSnippet, targetId } });
      const read = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId } });
      return { search, read };
    }

    try {
      const [a, b] = await Promise.all([workflow("task-a", "target-a"), workflow("task-b", "target-b")]);
      assert.match(a.read.structuredContent.content, /target-a/);
      assert.doesNotMatch(a.read.structuredContent.content, /target-b/);
      assert.match(b.read.structuredContent.content, /target-b/);
      assert.doesNotMatch(b.read.structuredContent.content, /target-a/);
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

test("no absolute worktree path leaks through MCP errors, registry targets, or health for a Mottainai-managed adapter", async () => {
  await withTwoTargetRepos(async (repoA, repoB) => {
    const statusResponses = new Map([
      ["task-a", () => ok({ ...taskEntry({ taskId: "task-a" }), worktreePath: repoA })],
      ["task-b", () => ok({ ...taskEntry({ taskId: "task-b" }), worktreePath: repoB })]
    ]);
    const { run } = createFakeRun({
      listResponse: ok([taskEntry({ taskId: "task-a" }), taskEntry({ taskId: "task-b" })]),
      statusResponses
    });
    const provider = createMottainaiTargetProvider({ run });
    const { registry, mcpClient } = await startManaged(provider);
    try {
      const listed = await registry.listTargets(ADAPTER_ID);
      assert.ok(!JSON.stringify(listed).includes(repoA));
      assert.ok(!JSON.stringify(listed).includes(repoB));

      const health = await registry.health(ADAPTER_ID);
      assert.ok(!JSON.stringify(health).includes(repoA));
      assert.ok(!JSON.stringify(health).includes(repoB));

      const missing = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "no-such-task" } });
      assert.equal(missing.isError, true);
      assert.ok(!JSON.stringify(missing.content).includes(repoA));
      assert.ok(!JSON.stringify(missing.content).includes(repoB));
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

test("standalone OCR (no Mottainai/targetProvider at all) is unaffected", async () => {
  const registry = new AdapterRegistry();
  registry.register(createManifest());
  await registry.start(ADAPTER_ID);
  try {
    const response = await registry.resource(ADAPTER_ID).mcpClient.callTool({
      name: "repo_search",
      arguments: { query: "majiwari", paths: ["package.json"] }
    });
    assert.equal(response.isError, undefined);
  } finally {
    await registry.stop(ADAPTER_ID);
  }
});
