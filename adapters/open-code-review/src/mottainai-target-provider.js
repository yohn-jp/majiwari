import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { TARGET_PROVIDER_SCHEMA_VERSION, TargetNotFoundError, TargetProviderError, TargetUnavailableError, targetIdSchema } from "@majiwari/registry";

const execFileAsync = promisify(execFile);

export const DEFAULT_MOTTAINAI_COMMAND = process.env.MOTTAINAI_ADAPTER_COMMAND || "mottainai";
export const DEFAULT_TIMEOUT_MS = Number(process.env.MOTTAINAI_ADAPTER_TIMEOUT_MS ?? 15_000);
export const DEFAULT_MAX_BUFFER = Number(process.env.MOTTAINAI_ADAPTER_MAX_BUFFER ?? 10 * 1024 * 1024);

/**
 * Bounded, generic failure for this provider's own process/parse/schema
 * layer -- distinct from the registry's TargetNotFoundError/
 * TargetUnavailableError, which mean "Mottainai answered and the target is
 * known-gone/known-unavailable". This one means "Mottainai could not be
 * asked, or answered with something outside the supported #539 contract" --
 * per #30's contract, that must never be interpreted as a false empty
 * discovery snapshot. Its message is always one of the fixed strings below;
 * it never embeds command stdout/stderr/paths, since list()/get() are not
 * normalized by any downstream boundary (unlike resolve(), which
 * managed-transport.js normalizes) and this message can reach the operator
 * UI or registry projections unchanged.
 */
export class MottainaiTargetProviderError extends TargetProviderError {
  constructor(message) {
    super(message);
    this.name = "MottainaiTargetProviderError";
  }
}

// --- Raw #539 contract shapes -----------------------------------------
//
// `mottainai task list --json` / `mottainai task status --task-id <id>
// --json` per yohn-jp/mottainai#539 as fixed by #30's #45 decision comment
// and this issue's upstream-contract refinement:
//   - task list is a discovery snapshot/candidate projection only;
//     presence there does not guarantee current availability.
//   - task status --task-id is the authoritative fresh availability +
//     canonical worktree resolve, and is never cached.
// Both are validated strictly: a field this adapter does not recognize, or
// a missing required field, fails the whole response closed rather than
// silently passing through an unrecognized shape.

const commitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/i, "commit must be a hex sha");
const lifecycleStateSchema = z.enum(["active", "closed", "discarded"]);
const runtimeStateSchema = z.enum(["starting", "running", "stopping", "stopped", "unknown"]);

const taskEntryFields = {
  taskId: targetIdSchema,
  repository: z.string().min(1),
  branchName: z.string().min(1),
  headCommit: commitShaSchema,
  baseCommit: commitShaSchema.optional(),
  lifecycleState: lifecycleStateSchema,
  runtimeState: runtimeStateSchema
};

// `task list --json`: an array of candidate entries, never a worktree path.
const taskListSchema = z.array(z.object(taskEntryFields).strict());

// `task status --task-id <id> --json`: the same public fields plus, only
// when the task currently resolves to a live worktree, the canonical
// worktree path -- present here (the one place it is ever returned by
// Mottainai to this adapter) and nowhere else in this module's output.
const taskStatusSchema = z
  .object({ ...taskEntryFields, worktreePath: z.string().min(1).optional() })
  .strict();

function isAvailable(entry) {
  return entry.lifecycleState === "active" && entry.runtimeState === "running";
}

function toPublicTarget(entry) {
  return {
    id: entry.taskId,
    kind: "mottainai-task",
    displayName: `${entry.repository}@${entry.branchName}`,
    metadata: {
      repository: entry.repository,
      branchName: entry.branchName,
      headCommit: entry.headCommit,
      ...(entry.baseCommit !== undefined && { baseCommit: entry.baseCommit }),
      availability: isAvailable(entry) ? "available" : "unavailable"
    }
  };
}

async function defaultRun(args, { command, cwd, timeoutMs, maxBuffer }) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer,
      encoding: "utf8",
      windowsHide: true,
      shell: false
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    // A process that ran and exited non-zero carries a numeric `code`; a
    // process that never ran at all (binary missing, killed by timeout,
    // killed by signal) does not -- rethrown so invoke() below always
    // treats that case as an infra failure, never as a per-task result.
    if (typeof error.code === "number") return { stdout: error.stdout ?? "", exitCode: error.code };
    throw error;
  }
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Create a `@majiwari/registry` target-provider backed by the real
 * Mottainai CLI's #539 contract. Nothing here reads Mottainai/Nawabari
 * private state, registry files, or scans a filesystem root -- every fact
 * comes from parsing this process's own stdout for two fixed, public,
 * read-only invocations.
 *
 * `run` is an injectable seam (defaults to a real `execFile` invocation of
 * `command`) so tests can supply deterministic fixture/fake responses
 * without spawning a subprocess for every case -- the production path
 * always shells out.
 */
export function createMottainaiTargetProvider({
  command = DEFAULT_MOTTAINAI_COMMAND,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
  run = defaultRun
} = {}) {
  const runOpts = { command, cwd, timeoutMs, maxBuffer };
  // Local-only operator override (#30: "Majiwari may retain only bounded/
  // cacheable projection state needed for target lookup/freshness; it does
  // not become lifecycle authority"). This never talks to Mottainai and
  // never closes/discards a real session -- it only makes *this* provider
  // stop honoring an id even if Mottainai still reports it active.
  const locallyInvalidated = new Set();

  async function invoke(args) {
    try {
      return await run(args, runOpts);
    } catch {
      throw new MottainaiTargetProviderError("mottainai command could not be executed");
    }
  }

  /**
   * The one call this whole provider ever makes to resolve a specific
   * task-id's current state: always a fresh `task status --task-id`
   * invocation, never served from `list()`'s snapshot and never cached
   * across calls -- satisfies #30's fresh-resolve-before-every-workspace-
   * sensitive-operation and TOCTOU-fails-closed requirements together.
   */
  async function fetchStatus(id) {
    const { stdout, exitCode } = await invoke(["task", "status", "--task-id", id, "--json"]);
    if (exitCode !== 0) {
      // Mottainai could not resolve this task-id at all right now:
      // disappeared, closed-and-purged, or never existed. Indistinguishable
      // from here, and all fail closed the same way -- as "not found",
      // never as a false "empty" success and never as a fallback to
      // anything else.
      throw new TargetNotFoundError(id);
    }
    const parsed = parseJsonLoose(stdout);
    const validated = taskStatusSchema.safeParse(parsed);
    if (!validated.success || validated.data.taskId !== id) {
      throw new MottainaiTargetProviderError("mottainai task status returned output incompatible with the supported contract");
    }
    return validated.data;
  }

  return {
    schemaVersion: TARGET_PROVIDER_SCHEMA_VERSION,

    // Discovery snapshot only (#539/#30): candidate projection, never the
    // freshness authority. A process/parse/schema failure here is always a
    // MottainaiTargetProviderError, distinguishable from a genuine
    // zero-active-task snapshot (a successfully parsed empty array).
    async list() {
      const { stdout, exitCode } = await invoke(["task", "list", "--json"]);
      if (exitCode !== 0) {
        throw new MottainaiTargetProviderError("mottainai task list exited with a failure status");
      }
      const parsed = parseJsonLoose(stdout);
      const validated = taskListSchema.safeParse(parsed);
      if (!validated.success) {
        throw new MottainaiTargetProviderError("mottainai task list returned output incompatible with the supported contract");
      }
      return validated.data.map(toPublicTarget);
    },

    // Public metadata lookup for one target, backed by the same fresh
    // `task status` authority resolve() uses -- never the list snapshot --
    // so a caller cannot observe get() reporting availability that resolve()
    // would immediately contradict.
    async get(id) {
      if (locallyInvalidated.has(id)) throw new TargetUnavailableError(id);
      const entry = await fetchStatus(id);
      if (!isAvailable(entry)) throw new TargetUnavailableError(id);
      return toPublicTarget(entry);
    },

    // The only hook that ever returns a worktree path, and only inside
    // `descriptor` (never in the public projection). Matches this adapter's
    // own descriptor convention (`core.js#extractDescriptorRepoRoot`:
    // `{ repoRoot }`) so managed-transport.js's existing canonicalization/
    // fail-closed handling applies unchanged to a Mottainai-managed target.
    async resolve(id) {
      if (locallyInvalidated.has(id)) throw new TargetUnavailableError(id);
      const entry = await fetchStatus(id);
      if (!isAvailable(entry) || typeof entry.worktreePath !== "string" || entry.worktreePath.length === 0) {
        throw new TargetUnavailableError(id);
      }
      return { ...toPublicTarget(entry), descriptor: { repoRoot: entry.worktreePath } };
    },

    // Local-only suppression (see `locallyInvalidated` above): Majiwari
    // never asks Mottainai to close/discard/repair anything.
    async invalidate(id) {
      locallyInvalidated.add(id);
      return { id, invalidated: true };
    }
  };
}
