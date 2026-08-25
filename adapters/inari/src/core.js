import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_TIMEOUT_MS = Number(process.env.INARI_ADAPTER_TIMEOUT_MS ?? 30_000);
export const DEFAULT_MAX_BUFFER = Number(process.env.INARI_ADAPTER_MAX_BUFFER ?? 10 * 1024 * 1024);
export const MAX_FIELDS = 200;

/**
 * The `gh-inari` machine-readable contract (`inari --version --json`) this
 * adapter is written against and that `.github/workflows/ci.yml`'s
 * `inari-contract` job installs and verifies against. Bumping the CLI
 * requires bumping this constant (and the CI pin) in the same change,
 * rather than the adapter silently trusting whatever `gh-inari` version
 * happens to be on `PATH`.
 */
export const EXPECTED_INARI_NAME = "gh-inari";
export const EXPECTED_INARI_PROTOCOL = 1;
export const MINIMUM_INARI_VERSION = "0.8.0";

export function parseServerArgs(argv = []) {
  const result = { repo: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--repo") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--repo requires a path");
      result.repo = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

/** Reject values that could be mistaken for another CLI flag or that carry unsafe control characters. */
export function validateToken(value, name = "value") {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.startsWith("-") || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`${name} contains unsafe characters`);
  }
  return value;
}

export function validateArtifactNumber(value, name = "number") {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return num;
}

/** Field names must be simple identifiers -- Inari's own schema is the authority for which names are valid. */
const FIELD_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function buildFieldArgs(fields) {
  if (fields === undefined || fields === null) return [];
  const entries = Object.entries(fields);
  if (entries.length > MAX_FIELDS) {
    throw new Error(`fields must contain at most ${MAX_FIELDS} entries`);
  }
  const args = [];
  for (const [name, value] of entries) {
    if (!FIELD_NAME_PATTERN.test(name)) {
      throw new Error(`field name "${name}" must match ${FIELD_NAME_PATTERN}`);
    }
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== "string" || item.includes("\0")) {
        throw new Error(`field "${name}" must be a string value without NUL bytes`);
      }
      args.push("--field", `${name}=${item}`);
    }
  }
  return args;
}

export function buildTemplateSchemaArgs(domain, template, { compact } = {}) {
  const args = [domain, "schema", validateToken(template, "template"), "--json"];
  if (compact) args.push("--compact");
  return args;
}

export function buildGetArgs(domain, number, template) {
  const args = [domain, "get", String(validateArtifactNumber(number)), "--json"];
  if (template !== undefined) args.push("--template", validateToken(template, "template"));
  return args;
}

export function buildValidateArgs(domain, { number, template, fields } = {}) {
  if (number !== undefined) {
    const args = [domain, "validate", String(validateArtifactNumber(number)), "--json"];
    if (template !== undefined) args.push("--template", validateToken(template, "template"));
    return args;
  }
  if (template === undefined) {
    throw new Error("template is required when validating new content");
  }
  return [domain, "validate", "--template", validateToken(template, "template"), ...buildFieldArgs(fields), "--json"];
}

export function buildIssueCreateArgs(template, fields, { title } = {}) {
  const args = [
    "issue",
    "create",
    "--template",
    validateToken(template, "template"),
    ...buildFieldArgs(fields),
    "--json"
  ];
  if (title !== undefined) args.push("--title", validateToken(title, "title"));
  return args;
}

export function buildPullRequestCreateArgs(template, fields, { title, head, base, draft, maintainerCanModify } = {}) {
  const args = [
    "pr",
    "create",
    "--template",
    validateToken(template, "template"),
    ...buildFieldArgs(fields),
    "--json"
  ];
  if (title !== undefined) args.push("--title", validateToken(title, "title"));
  if (head !== undefined) args.push("--head", validateToken(head, "head"));
  if (base !== undefined) args.push("--base", validateToken(base, "base"));
  if (draft !== undefined) args.push(`--draft=${draft ? "true" : "false"}`);
  if (maintainerCanModify !== undefined) args.push(`--maintainer-can-modify=${maintainerCanModify ? "true" : "false"}`);
  return args;
}

export async function runCommand(command, args, { cwd, timeout = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, allowExitCodes = [0] } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      maxBuffer,
      encoding: "utf8",
      windowsHide: true,
      shell: false
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    if (allowExitCodes.includes(error.code)) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code };
    }
    const detail = [error.message, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed: ${detail}`);
  }
}

export async function resolveRepoRoot(configuredRoot = undefined) {
  configuredRoot = configuredRoot ?? process.env.INARI_REPO ?? process.cwd();
  const absolute = path.resolve(configuredRoot);
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: absolute });
  return (await realpath(result.stdout.trim())).replace(/[\\/]$/, "");
}

export function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}

/**
 * Run one `inari` invocation and parse its JSON stdout. Every governed
 * issue/pr/template command in this adapter is called with `--json`, and
 * Inari's own CLI always emits a structured `{ok|valid, ...}` JSON object
 * on stdout for those commands regardless of exit code (0 success, 1
 * usage, 2 validation, 3 remote, 4 internal) -- so every recognized exit
 * code is parsed and returned the same way, and the caller reads `ok`/
 * `valid`/`error` from the result instead of a thrown exception. Only a
 * genuine process failure (not found, timeout, non-JSON crash) throws.
 */
export async function runInari(args, { cwd, label }) {
  const completed = await runCommand("inari", args, { cwd, allowExitCodes: [0, 1, 2, 3, 4] });
  return parseJson(completed.stdout, label);
}

function parseVersionParts(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Deterministic `major.minor.patch` comparison, matching gh-inari's own `--minimum-version` semantics. */
export function versionAtLeast(actual, minimum) {
  const actualParts = parseVersionParts(actual);
  const minimumParts = parseVersionParts(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < actualParts.length; index += 1) {
    if (actualParts[index] !== minimumParts[index]) return actualParts[index] > minimumParts[index];
  }
  return true;
}

/**
 * Verify the configured repository, Inari's own machine-readable
 * compatibility surface (`inari --version --json`: expected `name`,
 * `protocol`, and a minimum `version`), and GitHub authentication
 * (`gh auth status`, whose output/credential value is never relayed --
 * only its exit code decides `github_authenticated`). Returns a single
 * structured report shared by `adapter_health`, `doctor.js`, and the
 * manifest's own `health()`; a version/protocol mismatch fails `ok`
 * deterministically with a `detail` naming exactly what is incompatible,
 * rather than the adapter silently trusting whatever `inari` is on `PATH`.
 */
export async function checkAdapterHealth(repoRoot) {
  const version = await runCommand("inari", ["--version", "--json"], { cwd: repoRoot, allowExitCodes: [0, 1, 2] });
  let versionInfo = {};
  let incompatibilityDetail;
  try {
    versionInfo = parseJson(version.stdout, "inari --version --json");
  } catch (error) {
    incompatibilityDetail = error.message;
  }

  const nameMatches = versionInfo.name === EXPECTED_INARI_NAME;
  const protocolMatches = versionInfo.protocol === EXPECTED_INARI_PROTOCOL;
  const versionSupported = versionAtLeast(versionInfo.version, MINIMUM_INARI_VERSION);
  const compatible = Boolean(versionInfo.ok) && nameMatches && protocolMatches && versionSupported;

  if (!compatible && incompatibilityDetail === undefined) {
    if (!nameMatches) {
      incompatibilityDetail = `expected the "${EXPECTED_INARI_NAME}" CLI, found "${versionInfo.name ?? "unknown"}"`;
    } else if (!protocolMatches) {
      incompatibilityDetail = `expected inari protocol ${EXPECTED_INARI_PROTOCOL}, found ${versionInfo.protocol ?? "unknown"}`;
    } else if (!versionSupported) {
      incompatibilityDetail = `inari ${versionInfo.version ?? "unknown"} is older than the minimum supported version ${MINIMUM_INARI_VERSION}`;
    }
  }

  const auth = await runCommand("gh", ["auth", "status"], { cwd: repoRoot, allowExitCodes: [0, 1] });
  const githubAuthenticated = auth.exitCode === 0;

  return {
    ok: compatible && githubAuthenticated,
    repo_root: repoRoot,
    inari_version: versionInfo.version,
    inari_protocol: versionInfo.protocol,
    inari_capabilities: versionInfo.capabilities,
    inari_compatible: compatible,
    github_authenticated: githubAuthenticated,
    ...(incompatibilityDetail
      ? { detail: incompatibilityDetail }
      : githubAuthenticated
        ? {}
        : { detail: "gh auth status did not report an authenticated account" })
  };
}
