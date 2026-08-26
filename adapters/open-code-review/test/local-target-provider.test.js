import test from "node:test";
import assert from "node:assert/strict";
import { TargetNotFoundError, TargetUnavailableError } from "@majiwari/registry";
import { createLocalTargetProvider } from "../src/local-target-provider.js";

test("local target provider rejects entries without an absolute repoRoot", () => {
  assert.throws(() => createLocalTargetProvider([{ id: "a", repoRoot: "relative/path" }]), /absolute repoRoot/);
  assert.throws(() => createLocalTargetProvider([{ id: "", repoRoot: "/abs/path" }]), /non-empty id/);
  assert.throws(() => createLocalTargetProvider([{ repoRoot: "/abs/path" }]), /non-empty id/);
});

test("list()/get() project only public fields; resolve() alone carries the descriptor", async () => {
  const provider = createLocalTargetProvider([
    { id: "target-a", repoRoot: "/abs/repo-a", kind: "worktree", displayName: "Repo A" },
    { id: "target-b", repoRoot: "/abs/repo-b" }
  ]);

  const listed = await provider.list();
  assert.deepEqual(listed, [
    { id: "target-a", kind: "worktree", displayName: "Repo A" },
    { id: "target-b" }
  ]);
  assert.ok(!JSON.stringify(listed).includes("/abs/repo-a"));
  assert.ok(!JSON.stringify(listed).includes("/abs/repo-b"));

  const got = await provider.get("target-a");
  assert.deepEqual(got, { id: "target-a", kind: "worktree", displayName: "Repo A" });
  assert.ok(!("descriptor" in got));

  const resolved = await provider.resolve("target-a");
  assert.deepEqual(resolved.descriptor, { repoRoot: "/abs/repo-a" });
});

test("unknown target id fails closed on get()/resolve()", async () => {
  const provider = createLocalTargetProvider([{ id: "target-a", repoRoot: "/abs/repo-a" }]);
  await assert.rejects(() => provider.get("missing"), TargetNotFoundError);
  await assert.rejects(() => provider.resolve("missing"), TargetNotFoundError);
});

test("invalidate() removes a target from list()/get()/resolve() without deleting its registration", async () => {
  const provider = createLocalTargetProvider([{ id: "target-a", repoRoot: "/abs/repo-a" }]);

  await provider.invalidate("target-a");

  assert.deepEqual(await provider.list(), []);
  await assert.rejects(() => provider.get("target-a"), TargetUnavailableError);
  await assert.rejects(() => provider.resolve("target-a"), TargetUnavailableError);
  await assert.rejects(() => provider.invalidate("missing"), TargetNotFoundError);
});
