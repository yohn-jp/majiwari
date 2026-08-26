import { execFile } from "node:child_process";
import path from "node:path";
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
 * TargetUnavailableError, which mean "mottainai answered and the target is
 * known-gone/known-unavailable". This one means "mottainai could not be
 * asked, answered with something outside the supported #539 CLI contract,
 * or reported a failure reason this adapter does not recognize". Its
 * message is always one of the fixed strings below; it never embeds
 * command stdout/stderr/paths, since list()/get() are not normalized by any
 * downstream boundary (unlike resolve(), which managed-transport.js
 * normalizes) and this message can reach the operator UI or registry
 * projections unchanged.
 */
export class MottainaiTargetProviderError extends TargetProviderError {
  constructor(message) {
    super(message);
    this.name = "MottainaiTargetProviderError";
  }
}

// --- The real, merged #539 CLI contract ---------------------------------
//
// Derived from yohn-jp/mottainai@ed64420 (merged PR #540, "feat(workflow):
// read-only cross-workspace task/session discovery (#539)"):
//   - src/cli.ts: `task list` prints `listTaskDiscoverySnapshot(store)`
//     verbatim; `task status --task-id <id>` prints the
//     `getTaskStatusById(...)` result verbatim and exits 0 when its `ok` is
//     true, 1 otherwise -- note this means exit code 1 is NOT itself proof
//     of a process failure: `{ ok: false, reason }` is a normal, printed,
//     schema-valid *domain* result at that same exit code. A real process
//     crash (e.g. the workflow state store failing to open) instead throws,
//     is caught by cli.ts's top-level handler, and prints nothing to
//     stdout -- only a message to stderr. So this module never branches on
//     exit code: it always attempts to parse+validate stdout, and a
//     genuine process/crash failure is indistinguishable from (and handled
//     identically to) unparseable/invalid stdout.
//   - src/workflow/domain/task.ts: `listTaskDiscoverySnapshot()` and
//     `getTaskStatusById()` are the two functions whose literal return
//     shapes are asserted below. `list` is documented there as a
//     **discovery snapshot / candidate projection only** -- its
//     `lifecycleState` is "last observed at snapshot time", never a live
//     availability signal, and it carries no worktree path at all.
//     `getTaskStatusById` is the **authoritative fresh resolve**: only its
//     `ok: true` result is trusted as "currently resolvable", and only it
//     ever returns a worktree path.

const LIFECYCLE_STATES = ["planned", "active", "committed", "pushed", "pull-request-open", "merged", "abandoned", "orphaned", "cleaned"];
const lifecycleStateSchema = z.enum(LIFECYCLE_STATES);

// `PublicRepositoryIdentity` (task.ts): an opaque `instanceId` UUID only --
// never an absolute path, remote URL, or branch name.
const repositoryIdentitySchema = z.object({ instanceId: z.string().min(1) }).strict();

// `TaskDiscoveryCandidate` (task.ts). `.strict()`: every field here is one
// this adapter actually projects into public metadata, so an unrecognized
// field is real contract drift worth failing closed on.
const taskDiscoveryCandidateSchema = z
  .object({
    taskId: targetIdSchema,
    repository: repositoryIdentitySchema,
    taskSlug: z.string().min(1),
    issueRef: z.string().min(1).optional(),
    branchName: z.string().min(1).optional(),
    baseBranch: z.string().min(1),
    baseCommit: z.string().min(1),
    lifecycleState: lifecycleStateSchema,
    updatedAt: z.number()
  })
  .strict();

// `TaskDiscoverySnapshot` (task.ts). `TASK_DISCOVERY_SCHEMA_VERSION` is
// pinned to the literal `1`; a future incompatible bump must fail closed
// rather than being silently parsed as if it were still version 1.
const taskDiscoverySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.number(),
    tasks: z.array(taskDiscoveryCandidateSchema)
  })
  .strict();

// `TaskRecord` (workflow/state/store.ts), embedded verbatim in a status
// success result. `.passthrough()`, not `.strict()`: this adapter only
// projects the fields below into public metadata and deliberately never
// re-exposes the rest (`nawabariSessionId`, `startIdempotencyKey`,
// `version`, `createdAt`) -- those are Mottainai/Nawabari-internal
// bookkeeping, not public target metadata, so their presence or absence is
// not this schema's concern.
const taskRecordSchema = z
  .object({
    taskId: targetIdSchema,
    instanceId: z.string().min(1),
    taskSlug: z.string().min(1),
    issueRef: z.string().min(1).optional(),
    lifecycleState: lifecycleStateSchema,
    baseBranch: z.string().min(1),
    baseCommit: z.string().min(1)
  })
  .passthrough();

// `TaskStatusByIdResult` success branch (task.ts). `.passthrough()`: real
// fields like `pullRequests`/`allowedNextTransitions`/`invalidTransitions`
// are part of the real envelope but never consumed here (#30 needs only
// the canonical worktree + safe display metadata), so they are allowed
// through without being modeled.
const taskStatusSuccessSchema = z
  .object({
    ok: z.literal(true),
    task: taskRecordSchema,
    worktreePath: z.string().min(1),
    branch: z.string().min(1).optional(),
    currentState: lifecycleStateSchema
  })
  .passthrough();

// `TaskStatusByIdResult` failure branch: exactly `{ ok: false, reason }` --
// nothing else, so `.strict()` here is meaningful (task.ts's own type is
// `{ ok: false; reason: string }`, no optional extras).
const taskStatusFailureSchema = z.object({ ok: z.literal(false), reason: z.string().min(1) }).strict();

const taskStatusResultSchema = z.union([taskStatusSuccessSchema, taskStatusFailureSchema]);

// Reasons `getTaskStatusById()` actually returns (task.ts's own doc comment
// on `TaskStatusByIdResult`): `task-not-found`, `task-unavailable:<state>`,
// `repository-path-unavailable`, `session-unavailable`, `worktree-unavailable`.
// Only `task-not-found` means "no such task"; every other known reason means
// "mottainai knows this task but cannot currently resolve it" -- both map to
// the registry's two fail-closed target-error shapes, never to a fallback.
// Any *other* reason string is itself unrecognized contract drift, not a
// known unavailability -- it fails closed as a bounded provider error
// instead of being silently treated as "just unavailable".
function mapFailureReason(id, reason) {
  if (reason === "task-not-found") return new TargetNotFoundError(id);
  if (reason === "repository-path-unavailable" || reason === "session-unavailable" || reason === "worktree-unavailable" || reason.startsWith("task-unavailable:")) {
    return new TargetUnavailableError(id);
  }
  return new MottainaiTargetProviderError("mottainai task status reported an unrecognized failure reason");
}

/**
 * Build this adapter's public target projection from a normalized entry --
 * either a `TaskDiscoveryCandidate` (list(), snapshot-only fields) or a
 * fresh status result's `task` + live `branch`/`currentState` (get()/
 * resolve()). Never includes a worktree path; never includes a fabricated
 * "availability" field for list()'s snapshot data, since #539's discovery
 * snapshot documents its `lifecycleState` as merely "last observed", not a
 * live signal -- only a fresh `task status --task-id` result (`ok: true`)
 * is ever treated as "currently available" by this module.
 */
function toPublicTarget({ taskId, instanceId, taskSlug, issueRef, branchName, baseBranch, baseCommit, lifecycleState }) {
  return {
    id: taskId,
    kind: "mottainai-task",
    displayName: branchName ? `${taskSlug}@${branchName}` : taskSlug,
    metadata: {
      repositoryInstanceId: instanceId,
      taskSlug,
      ...(issueRef !== undefined && { issueRef }),
      ...(branchName !== undefined && { branchName }),
      baseBranch,
      baseCommit,
      lifecycleState
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
    // A process that ran and exited carries a numeric `code` -- including a
    // non-zero exit that is nonetheless a normal, schema-valid domain
    // result (see the `task status` note above). A process that never ran
    // at all (binary missing, killed by timeout/signal) does not -- rethrown
    // so invoke() below always treats that case as an infra failure.
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
 * `command`) so tests can supply deterministic fixture responses shaped
 * exactly like the real CLI's output without spawning a subprocess for
 * every case -- the production path always shells out.
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
  // never closes/discards a real task -- it only makes *this* provider
  // stop honoring an id even if Mottainai would still resolve it.
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
   * invocation, never served from list()'s snapshot and never cached
   * across calls -- satisfies #30's fresh-resolve-before-every-workspace-
   * sensitive-operation and TOCTOU-fails-closed requirements together.
   *
   * Exit code is deliberately never consulted (see the contract note
   * above): stdout is always parsed and validated against the real
   * discriminated result shape, and a `{ ok: false, reason }` body is
   * mapped to the matching registry error rather than treated as an infra
   * failure just because the process also happened to exit 1.
   */
  async function fetchStatus(id) {
    const { stdout } = await invoke(["task", "status", "--task-id", id, "--json"]);
    const parsed = parseJsonLoose(stdout);
    const validated = taskStatusResultSchema.safeParse(parsed);
    if (!validated.success) {
      throw new MottainaiTargetProviderError("mottainai task status returned output incompatible with the supported contract");
    }
    const result = validated.data;
    if (!result.ok) throw mapFailureReason(id, result.reason);
    if (result.task.taskId !== id) {
      throw new MottainaiTargetProviderError("mottainai task status returned a mismatched task id");
    }
    if (!path.isAbsolute(result.worktreePath)) {
      throw new MottainaiTargetProviderError("mottainai task status returned a non-absolute worktree path");
    }
    return result;
  }

  function publicFromStatus(result) {
    return toPublicTarget({
      taskId: result.task.taskId,
      instanceId: result.task.instanceId,
      taskSlug: result.task.taskSlug,
      issueRef: result.task.issueRef,
      branchName: result.branch,
      baseBranch: result.task.baseBranch,
      baseCommit: result.task.baseCommit,
      lifecycleState: result.currentState
    });
  }

  return {
    schemaVersion: TARGET_PROVIDER_SCHEMA_VERSION,

    // Discovery snapshot only (#539/#30): candidate projection, never the
    // freshness authority. Never derives an "availability" signal from
    // snapshot fields #539 does not provide as live -- see toPublicTarget().
    // A process/parse/schema failure here is always a
    // MottainaiTargetProviderError, distinguishable from a genuine
    // zero-active-task snapshot (a successfully parsed empty `tasks: []`).
    async list() {
      const { stdout } = await invoke(["task", "list", "--json"]);
      const parsed = parseJsonLoose(stdout);
      const validated = taskDiscoverySnapshotSchema.safeParse(parsed);
      if (!validated.success) {
        throw new MottainaiTargetProviderError("mottainai task list returned output incompatible with the supported contract");
      }
      return validated.data.tasks.map((candidate) =>
        toPublicTarget({
          taskId: candidate.taskId,
          instanceId: candidate.repository.instanceId,
          taskSlug: candidate.taskSlug,
          issueRef: candidate.issueRef,
          branchName: candidate.branchName,
          baseBranch: candidate.baseBranch,
          baseCommit: candidate.baseCommit,
          lifecycleState: candidate.lifecycleState
        })
      );
    },

    // Public metadata lookup for one target, backed by the same fresh
    // `task status` authority resolve() uses -- never the list snapshot --
    // so a caller cannot observe get() reporting a target resolve() would
    // immediately contradict.
    async get(id) {
      if (locallyInvalidated.has(id)) throw new TargetUnavailableError(id);
      const result = await fetchStatus(id);
      return publicFromStatus(result);
    },

    // The only hook that ever returns a worktree path, and only inside
    // `descriptor` (never in the public projection). Matches this adapter's
    // own descriptor convention (`core.js#extractDescriptorRepoRoot`:
    // `{ repoRoot }`) so managed-transport.js's existing canonicalization/
    // fail-closed handling applies unchanged to a Mottainai-managed target.
    async resolve(id) {
      if (locallyInvalidated.has(id)) throw new TargetUnavailableError(id);
      const result = await fetchStatus(id);
      return { ...publicFromStatus(result), descriptor: { repoRoot: result.worktreePath } };
    },

    // Local-only suppression (see `locallyInvalidated` above): Majiwari
    // never asks Mottainai to close/discard/repair anything.
    async invalidate(id) {
      locallyInvalidated.add(id);
      return { id, invalidated: true };
    }
  };
}
