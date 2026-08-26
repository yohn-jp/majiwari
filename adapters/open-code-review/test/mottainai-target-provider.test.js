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

// --- Fixtures shaped exactly like the real, merged yohn-jp/mottainai#539
// CLI contract (yohn-jp/mottainai@ed64420, PR #540:
// "feat(workflow): read-only cross-workspace task/session discovery
// (#539)") -- read directly from `src/cli.ts` (`task list` / `task status
// --task-id`) and `src/workflow/domain/task.ts`
// (`listTaskDiscoverySnapshot` / `getTaskStatusById`), never inferred from
// #45's prose. Tests below build requests against these exact shapes so
// they cannot pass against an invented contract.

const TASK_ID_A = "b3b6c8b0-40a1-4a11-9abc-1234567890ab";
const TASK_ID_B = "c4c7d9c1-51b2-4b22-8bcd-2345678901bc";
const INSTANCE_ID_A = "9d1c9c0a-aaaa-4bbb-8ccc-000000000001";
const INSTANCE_ID_B = "9d1c9c0a-aaaa-4bbb-8ccc-000000000002";

function ok(payload, exitCode = 0) {
  return { stdout: JSON.stringify(payload), exitCode };
}

function processFailure(exitCode = 1) {
  // Matches cli.ts's top-level catch: a real crash prints nothing to
  // stdout (only a message to stderr) and exits non-zero.
  return { stdout: "", exitCode };
}

// `TaskDiscoveryCandidate` (task.ts) as `listTaskDiscoverySnapshot()`
// actually returns it, with no worktree path anywhere on it.
function discoveryCandidate(overrides = {}) {
  return {
    taskId: TASK_ID_A,
    repository: { instanceId: INSTANCE_ID_A },
    taskSlug: "add-mottainai-provider",
    issueRef: "30",
    branchName: "feat/30-mottainai-managed-target-provider",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    lifecycleState: "active",
    updatedAt: Date.now(),
    ...overrides
  };
}

// `TaskDiscoverySnapshot` (task.ts): the exact object envelope
// `mottainai task list --json` prints -- schemaVersion + generatedAt +
// tasks[], never a bare array.
function discoverySnapshot(tasks) {
  return { schemaVersion: 1, generatedAt: Date.now(), tasks };
}

// `TaskRecord` (workflow/state/store.ts), embedded verbatim under `task` in
// a status success result -- includes Mottainai/Nawabari-internal
// bookkeeping fields (`nawabariSessionId`, `version`, `createdAt`) this
// adapter must never re-project as public metadata.
function taskRecord(overrides = {}) {
  return {
    taskId: TASK_ID_A,
    instanceId: INSTANCE_ID_A,
    taskSlug: "add-mottainai-provider",
    issueRef: "30",
    nawabariSessionId: "nawabari-session-internal-opaque-id",
    lifecycleState: "active",
    version: 3,
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    createdAt: Date.now() - 100_000,
    updatedAt: Date.now(),
    ...overrides
  };
}

// `TaskStatusByIdSuccess` (task.ts): the exact object `getTaskStatusById()`
// returns on success and `task status --task-id --json` prints verbatim.
function statusSuccess({ worktreePath = "/tmp/example-mottainai-worktree", branch = "feat/30-mottainai-managed-target-provider", task = {}, currentState = "active" } = {}) {
  return {
    ok: true,
    task: taskRecord(task),
    worktreePath,
    branch,
    pullRequests: [],
    currentState,
    allowedNextTransitions: ["committed"],
    invalidTransitions: []
  };
}

function statusFailure(reason) {
  return { ok: false, reason };
}

/**
 * Deterministic fake for the injectable `run` seam
 * (`mottainai-target-provider.js`'s `run` option): dispatches on the real
 * `task list`/`task status --task-id <id>` argv shape without spawning any
 * subprocess. `listResponse`/`statusResponses` may be plain values or
 * zero-arg functions (so a test can mutate what the "CLI" would return
 * between two provider calls -- e.g. to simulate disappearance between
 * list() and resolve()).
 */
function createFakeRun({ listResponse = ok(discoverySnapshot([])), statusResponses = new Map() } = {}) {
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
      if (!responder) return processFailure(1);
      return typeof responder === "function" ? responder() : responder;
    }
    throw new Error(`fake mottainai run: unexpected invocation ${JSON.stringify(args)}`);
  };
  return { run, calls };
}

// --- Contract regression tests -------------------------------------------

test("real list envelope: an object with schemaVersion/generatedAt/tasks, not a bare array", async () => {
  const { run } = createFakeRun({
    listResponse: ok(discoverySnapshot([discoveryCandidate({ taskId: TASK_ID_A }), discoveryCandidate({ taskId: TASK_ID_B, repository: { instanceId: INSTANCE_ID_B } })]))
  });
  const provider = createMottainaiTargetProvider({ run });
  const listed = await provider.list();
  assert.equal(listed.length, 2);
});

test("a bare array (the invented shape from before this fix) is rejected as incompatible, not accepted", async () => {
  const { run } = createFakeRun({ listResponse: ok([discoveryCandidate()]) });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.list(), MottainaiTargetProviderError);
});

test("schemaVersion mismatch fails closed instead of being parsed as version 1", async () => {
  const { run } = createFakeRun({ listResponse: ok({ schemaVersion: 2, generatedAt: Date.now(), tasks: [] }) });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.list(), MottainaiTargetProviderError);
});

test("repository identity is the real { instanceId } shape, never an invented owner/name slug", async () => {
  const { run } = createFakeRun({ listResponse: ok(discoverySnapshot([discoveryCandidate()])) });
  const provider = createMottainaiTargetProvider({ run });
  const [target] = await provider.list();
  assert.equal(target.metadata.repositoryInstanceId, INSTANCE_ID_A);
  assert.ok(!("repository" in target.metadata), "public metadata key is repositoryInstanceId, not a raw repository object");
});

test("a discovery candidate carrying a worktree path (contract violation) is rejected, not silently trusted", async () => {
  const { run } = createFakeRun({
    listResponse: ok({ schemaVersion: 1, generatedAt: Date.now(), tasks: [{ ...discoveryCandidate(), worktreePath: "/should/never/appear/in/list/output" }] })
  });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.list(), MottainaiTargetProviderError);
});

test("list() never invents headCommit or runtimeState fields that #539 does not provide", async () => {
  const { run } = createFakeRun({ listResponse: ok(discoverySnapshot([discoveryCandidate()])) });
  const provider = createMottainaiTargetProvider({ run });
  const [target] = await provider.list();
  assert.ok(!("headCommit" in target.metadata));
  assert.ok(!("runtimeState" in target.metadata));
  assert.ok(!("availability" in target.metadata), "list()'s snapshot lifecycleState must not be presented as a derived live-availability signal");
  assert.equal(target.metadata.lifecycleState, "active");
  assert.equal(target.metadata.baseBranch, "main");
  assert.equal(target.metadata.baseCommit, "a".repeat(40));
});

test("list() omits issueRef/branchName entirely (never null) when the real candidate has none", async () => {
  const candidate = discoveryCandidate();
  delete candidate.issueRef;
  delete candidate.branchName;
  const { run } = createFakeRun({ listResponse: ok(discoverySnapshot([candidate])) });
  const provider = createMottainaiTargetProvider({ run });
  const [target] = await provider.list();
  assert.ok(!("issueRef" in target.metadata));
  assert.ok(!("branchName" in target.metadata));
  assert.equal(target.displayName, "add-mottainai-provider");
});

test("empty discovery snapshot ({ tasks: [] }) is a valid success, distinct from a provider failure", async () => {
  const { run } = createFakeRun({ listResponse: ok(discoverySnapshot([])) });
  const provider = createMottainaiTargetProvider({ run });
  assert.deepEqual(await provider.list(), []);
});

test("a real process crash (empty stdout, non-zero exit, per cli.ts's top-level catch) surfaces as a bounded error, never a false empty list", async () => {
  const { run } = createFakeRun({ listResponse: processFailure(1) });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.list(), MottainaiTargetProviderError);
});

test("a binary that cannot even be spawned surfaces as a bounded error", async () => {
  const run = async () => {
    const error = new Error("spawn mottainai ENOENT");
    error.code = "ENOENT";
    throw error;
  };
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.list(), MottainaiTargetProviderError);
});

test("real status success envelope: ok/task/worktreePath/branch/currentState map to the correct public target and descriptor", async () => {
  const { run } = createFakeRun({
    statusResponses: new Map([[TASK_ID_A, () => ok(statusSuccess({ worktreePath: "/tmp/real-status-worktree", branch: "feat/example", currentState: "committed" }), 0)]])
  });
  const provider = createMottainaiTargetProvider({ run });

  const resolved = await provider.resolve(TASK_ID_A);
  assert.equal(resolved.descriptor.repoRoot, "/tmp/real-status-worktree");
  assert.equal(resolved.id, TASK_ID_A);
  assert.equal(resolved.metadata.repositoryInstanceId, INSTANCE_ID_A);
  assert.equal(resolved.metadata.branchName, "feat/example");
  assert.equal(resolved.metadata.lifecycleState, "committed");
  // Internal TaskRecord bookkeeping (nawabariSessionId/version/createdAt)
  // must never be re-projected as public metadata.
  assert.ok(!("nawabariSessionId" in resolved.metadata));
  assert.ok(!("version" in resolved.metadata));
  assert.ok(!("createdAt" in resolved.metadata));

  const got = await provider.get(TASK_ID_A);
  assert.ok(!("descriptor" in got));
  assert.equal(got.metadata.lifecycleState, "committed");
});

test("representative #539 failure reasons map to the correct registry target error", async () => {
  const cases = [
    ["task-not-found", TargetNotFoundError],
    ["task-unavailable:merged", TargetUnavailableError],
    ["task-unavailable:cleaned", TargetUnavailableError],
    ["task-unavailable:abandoned", TargetUnavailableError],
    ["task-unavailable:orphaned", TargetUnavailableError],
    ["repository-path-unavailable", TargetUnavailableError],
    ["session-unavailable", TargetUnavailableError],
    ["worktree-unavailable", TargetUnavailableError]
  ];
  for (const [reason, ExpectedError] of cases) {
    // Real CLI behavior: exit code is always 1 for any ok:false result --
    // the discriminator is the parsed JSON body, not the exit code.
    const { run } = createFakeRun({ statusResponses: new Map([[TASK_ID_A, () => ok(statusFailure(reason), 1)]]) });
    const provider = createMottainaiTargetProvider({ run });
    await assert.rejects(() => provider.resolve(TASK_ID_A), ExpectedError, `reason "${reason}" should map to ${ExpectedError.name}`);
    await assert.rejects(() => provider.get(TASK_ID_A), ExpectedError, `reason "${reason}" should map to ${ExpectedError.name}`);
  }
});

test("an unrecognized #539 failure reason is a bounded provider error, not a silently accepted fallback", async () => {
  const { run } = createFakeRun({ statusResponses: new Map([[TASK_ID_A, () => ok(statusFailure("some-future-reason-this-adapter-does-not-know"), 1)]]) });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.resolve(TASK_ID_A), MottainaiTargetProviderError);
});

test("exit code 1 with a valid ok:false body is a normal domain result, not treated as a process crash", async () => {
  // Regression guard: an earlier (incorrect) implementation treated any
  // non-zero exit as an automatic TargetNotFoundError without reading
  // stdout at all. The real CLI uses exit 1 for every ok:false reason.
  const { run, calls } = createFakeRun({ statusResponses: new Map([[TASK_ID_A, () => ok(statusFailure("task-unavailable:merged"), 1)]]) });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.resolve(TASK_ID_A), TargetUnavailableError);
  assert.equal(calls.status, 1);
});

test("resolve() performs a fresh call every time and is never served from a cached list() snapshot", async () => {
  let worktree = "/tmp/mottainai-worktree-v1";
  const statusResponses = new Map([[TASK_ID_A, () => ok(statusSuccess({ worktreePath: worktree }))]]);
  const { run, calls } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });

  const first = await provider.resolve(TASK_ID_A);
  assert.equal(first.descriptor.repoRoot, worktree);

  worktree = "/tmp/mottainai-worktree-v2";
  const second = await provider.resolve(TASK_ID_A);
  assert.equal(second.descriptor.repoRoot, worktree);
  assert.equal(calls.status, 2, "each resolve() call must hit mottainai again, never a cache");
});

test("target disappearance between list() and resolve() fails closed as not-found (TOCTOU)", async () => {
  const listResponse = ok(discoverySnapshot([discoveryCandidate({ taskId: TASK_ID_A })]));
  // No entry for TASK_ID_A in statusResponses simulates the real CLI's
  // "task-not-found" reason once it disappears from the store.
  const { run } = createFakeRun({ listResponse, statusResponses: new Map([[TASK_ID_A, () => ok(statusFailure("task-not-found"), 1)]]) });
  const provider = createMottainaiTargetProvider({ run });

  const listed = await provider.list();
  assert.equal(listed[0].id, TASK_ID_A);

  await assert.rejects(() => provider.resolve(TASK_ID_A), TargetNotFoundError);
  await assert.rejects(() => provider.get(TASK_ID_A), TargetNotFoundError);
});

test("resolve() fails closed when the success envelope's worktreePath is not absolute", async () => {
  const { run } = createFakeRun({ statusResponses: new Map([[TASK_ID_A, () => ok(statusSuccess({ worktreePath: "relative/not-absolute" }))]]) });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.resolve(TASK_ID_A), MottainaiTargetProviderError);
});

test("malformed status output fails closed as a bounded provider error, not a silent unavailability", async () => {
  const statusResponses = new Map([[TASK_ID_A, () => ({ stdout: "{not valid json", exitCode: 0 })]]);
  const { run } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.resolve(TASK_ID_A), MottainaiTargetProviderError);
});

test("a status result for the wrong task id fails closed as a bounded provider error", async () => {
  const statusResponses = new Map([[TASK_ID_A, () => ok(statusSuccess({ task: { taskId: TASK_ID_B } }))]]);
  const { run } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });
  await assert.rejects(() => provider.resolve(TASK_ID_A), MottainaiTargetProviderError);
});

test("invalidate() makes one target deterministically unavailable while an unrelated target stays usable", async () => {
  const statusResponses = new Map([
    [TASK_ID_A, () => ok(statusSuccess({ worktreePath: "/tmp/a", task: { taskId: TASK_ID_A, instanceId: INSTANCE_ID_A } }))],
    [TASK_ID_B, () => ok(statusSuccess({ worktreePath: "/tmp/b", task: { taskId: TASK_ID_B, instanceId: INSTANCE_ID_B } }))]
  ]);
  const { run } = createFakeRun({ statusResponses });
  const provider = createMottainaiTargetProvider({ run });

  await provider.invalidate(TASK_ID_A);
  await assert.rejects(() => provider.resolve(TASK_ID_A), TargetUnavailableError);
  await assert.rejects(() => provider.get(TASK_ID_A), TargetUnavailableError);

  const stillGood = await provider.resolve(TASK_ID_B);
  assert.equal(stillGood.descriptor.repoRoot, "/tmp/b");
});

test("no configured/resolved absolute path ever appears in a thrown error's message", async () => {
  const secretPath = "/abs/secret/mottainai-worktree-should-not-leak";
  const scenarios = [
    () => createFakeRun({ listResponse: processFailure(1) }),
    () => createFakeRun({ listResponse: { stdout: `not json, but mentions ${secretPath}`, exitCode: 0 } }),
    () => createFakeRun({ statusResponses: new Map([[TASK_ID_A, () => ({ stdout: `garbage referencing ${secretPath}`, exitCode: 0 })]]) })
  ];
  for (const build of scenarios) {
    const { run } = build();
    const provider = createMottainaiTargetProvider({ run });
    try {
      await provider.list();
      await provider.resolve(TASK_ID_A);
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
      [TASK_ID_A, () => ok(statusSuccess({ worktreePath: repoA, task: { taskId: TASK_ID_A, instanceId: INSTANCE_ID_A } }))],
      [TASK_ID_B, () => ok(statusSuccess({ worktreePath: repoB, task: { taskId: TASK_ID_B, instanceId: INSTANCE_ID_B } }))]
    ]);
    const { run } = createFakeRun({
      listResponse: ok(
        discoverySnapshot([discoveryCandidate({ taskId: TASK_ID_A, repository: { instanceId: INSTANCE_ID_A } }), discoveryCandidate({ taskId: TASK_ID_B, repository: { instanceId: INSTANCE_ID_B } })])
      ),
      statusResponses
    });
    const provider = createMottainaiTargetProvider({ run });
    const { registry, mcpClient } = await startManaged(provider);
    try {
      const readA = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: TASK_ID_A } });
      const readB = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: TASK_ID_B } });
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
      [TASK_ID_A, () => ok(statusSuccess({ worktreePath: repoA, task: { taskId: TASK_ID_A, instanceId: INSTANCE_ID_A } }))],
      [TASK_ID_B, () => ok(statusSuccess({ worktreePath: repoB, task: { taskId: TASK_ID_B, instanceId: INSTANCE_ID_B } }))]
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
      const [a, b] = await Promise.all([workflow(TASK_ID_A, "target-a"), workflow(TASK_ID_B, "target-b")]);
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
      [TASK_ID_A, () => ok(statusSuccess({ worktreePath: repoA, task: { taskId: TASK_ID_A, instanceId: INSTANCE_ID_A } }))],
      [TASK_ID_B, () => ok(statusSuccess({ worktreePath: repoB, task: { taskId: TASK_ID_B, instanceId: INSTANCE_ID_B } }))]
    ]);
    const { run } = createFakeRun({
      listResponse: ok(
        discoverySnapshot([discoveryCandidate({ taskId: TASK_ID_A, repository: { instanceId: INSTANCE_ID_A } }), discoveryCandidate({ taskId: TASK_ID_B, repository: { instanceId: INSTANCE_ID_B } })])
      ),
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

      const missing = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "00000000-0000-4000-8000-000000000000" } });
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
