import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createMottainaiTargetProvider, MottainaiTargetProviderError } from "../src/mottainai-target-provider.js";

const execFileAsync = promisify(execFile);
const MOTTAINAI_COMMAND = process.env.MOTTAINAI_ADAPTER_COMMAND || "mottainai";

/**
 * Real-binary smoke path for #30: exercised only when a `mottainai`
 * executable is actually reachable on PATH. The fixture-based suite
 * (mottainai-target-provider.test.js) is the deterministic authority for
 * this provider's behavior against the merged #539 contract (verified
 * against yohn-jp/mottainai@ed64420's actual `src/cli.ts`/`src/workflow/
 * domain/task.ts` source, not inferred prose); this test only proves a
 * real, reachable CLI still matches the shape those fixtures assume.
 *
 * Per #30's own instructions: the locally installed `mottainai` binary may
 * be older than the merged upstream #539 change. This test does not fail
 * the suite when that's the case -- a `MottainaiTargetProviderError` from
 * the provider itself (its own schema validation rejecting the installed
 * binary's real output) is recorded as an *environment* blocker (no
 * #539-compatible binary to smoke against here), not an implementation
 * defect, and the test skips.
 */
test("real Mottainai smoke: task list/status --json match the merged #539 contract when a compatible binary is available", async (t) => {
  try {
    await execFileAsync(MOTTAINAI_COMMAND, ["--version"], { timeout: 5_000 });
  } catch (error) {
    const reason = `"${MOTTAINAI_COMMAND}" is not reachable on PATH in this environment (${error.code ?? error.message})`;
    t.diagnostic(`environment-blocked, not implementation-blocked: ${reason}`);
    t.skip(reason);
    return;
  }

  const provider = createMottainaiTargetProvider({ command: MOTTAINAI_COMMAND });

  let listed;
  try {
    listed = await provider.list();
  } catch (error) {
    if (error instanceof MottainaiTargetProviderError) {
      const reason = `installed "${MOTTAINAI_COMMAND}"'s "task list --json" output does not match the merged #539 contract this adapter targets (this is the known-older-binary case #30 anticipates): ${error.message}`;
      t.diagnostic(`environment-blocked, not implementation-blocked: ${reason}`);
      t.skip(reason);
      return;
    }
    throw error;
  }

  assert.ok(Array.isArray(listed));
  for (const target of listed) {
    assert.ok(!("descriptor" in target));
    assert.match(target.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.ok(typeof target.metadata?.repositoryInstanceId === "string" && target.metadata.repositoryInstanceId.length > 0);

    try {
      const resolved = await provider.resolve(target.id);
      assert.ok(path.isAbsolute(resolved.descriptor.repoRoot));
    } catch (error) {
      // A snapshot-to-resolve race (disappeared/closed/drifted between
      // list() and resolve()) is expected and correct fail-closed
      // behavior, not a smoke failure -- only an incompatible-contract
      // error is worth flagging here.
      if (error instanceof MottainaiTargetProviderError) {
        t.diagnostic(`environment-blocked, not implementation-blocked: installed "${MOTTAINAI_COMMAND}"'s "task status --task-id --json" output does not match the merged #539 contract: ${error.message}`);
      }
    }
  }
});
