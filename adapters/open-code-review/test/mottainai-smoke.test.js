import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMottainaiTargetProvider } from "../src/mottainai-target-provider.js";

const execFileAsync = promisify(execFile);
const MOTTAINAI_COMMAND = process.env.MOTTAINAI_ADAPTER_COMMAND || "mottainai";

/**
 * Real-binary smoke path for #30: exercised only when a `mottainai`
 * executable is actually reachable on PATH *and* it exposes the #539
 * contract (`task list --json` / `task status --task-id --json`). The
 * fixture-based suite (mottainai-target-provider.test.js) is the
 * deterministic authority for this provider's behavior against that
 * contract; this test only proves the real CLI still matches the shape the
 * fixtures assume, when one is available to check against.
 *
 * Per #30's own instructions: the locally installed `mottainai` binary may
 * be older than the merged upstream #539 change. This test does not fail
 * the suite when that's the case -- it records the gap as an
 * *environment* blocker (no compatible binary to smoke against here), not
 * an implementation defect, and skips.
 */
async function detectMottainaiContract() {
  let versionProbe;
  try {
    versionProbe = await execFileAsync(MOTTAINAI_COMMAND, ["--version"], { timeout: 5_000 });
  } catch (error) {
    return { available: false, reason: `"${MOTTAINAI_COMMAND}" is not reachable on PATH in this environment (${error.code ?? error.message})` };
  }

  let statusHelp;
  try {
    statusHelp = await execFileAsync(MOTTAINAI_COMMAND, ["task", "status", "--help"], { timeout: 5_000 });
  } catch (error) {
    return { available: false, reason: `"${MOTTAINAI_COMMAND} task status --help" failed (${error.code ?? error.message})`, version: versionProbe.stdout.trim() };
  }

  const helpText = `${statusHelp.stdout}\n${statusHelp.stderr}`;
  const supportsTaskId = /--task-id/.test(helpText);
  const supportsJson = /--json/.test(helpText);
  if (!supportsTaskId || !supportsJson) {
    return {
      available: false,
      reason: `installed "${MOTTAINAI_COMMAND}" does not expose the #539 "task status --task-id --json" contract (this is the known-older-binary case #30 anticipates)`,
      version: versionProbe.stdout.trim()
    };
  }
  return { available: true, version: versionProbe.stdout.trim() };
}

test("real Mottainai smoke: task list --json is well-formed when a #539-compatible binary is available", async (t) => {
  const detection = await detectMottainaiContract();
  if (!detection.available) {
    t.diagnostic(`environment-blocked, not implementation-blocked: ${detection.reason}`);
    t.skip(detection.reason);
    return;
  }

  const provider = createMottainaiTargetProvider({ command: MOTTAINAI_COMMAND });
  const listed = await provider.list();
  assert.ok(Array.isArray(listed));
  for (const target of listed) {
    assert.ok(!("descriptor" in target));
    if (target.metadata?.availability === "available") {
      const resolved = await provider.resolve(target.id);
      assert.ok(typeof resolved.descriptor.repoRoot === "string" && resolved.descriptor.repoRoot.length > 0);
    }
  }
});
