import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_TIMEOUT_MS = Number(process.env.OCR_ADAPTER_TIMEOUT_MS ?? 30_000);
export const DEFAULT_MAX_BUFFER = Number(process.env.OCR_ADAPTER_MAX_BUFFER ?? 10 * 1024 * 1024);

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

export function validateRef(ref, name = "ref") {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (ref.startsWith("-") || ref.includes("\0") || /[\r\n]/.test(ref)) {
    throw new Error(`${name} contains unsafe characters`);
  }
  return ref;
}

export function validateRelativePath(value, name = "path") {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.includes("\0") || /[\r\n]/.test(value) || path.isAbsolute(value)) {
    throw new Error(`${name} must be a safe repository-relative path`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${name} escapes the repository root`);
  }
  return normalized;
}

export function buildPreviewArgs({ from, to, commit, exclude, background } = {}) {
  if (commit && (from || to)) {
    throw new Error("commit mode cannot be combined with range mode");
  }
  if ((from && !to) || (!from && to)) {
    throw new Error("range mode requires both from and to");
  }

  const args = ["delegate", "preview", "--format", "json"];
  if (commit) args.push("--commit", validateRef(commit, "commit"));
  if (from) args.push("--from", validateRef(from, "from"));
  if (to) args.push("--to", validateRef(to, "to"));
  if (exclude) args.push("--exclude", exclude);
  if (background) args.push("--background", background);
  return args;
}

export function buildScanPreviewArgs({ path: scanPath, exclude, background } = {}) {
  const args = ["scan", "--preview", "--format", "json"];
  if (scanPath) {
    const parts = String(scanPath).split(",").map((p) => validateRelativePath(p.trim(), "path"));
    args.push("--path", parts.join(","));
  }
  if (exclude) args.push("--exclude", exclude);
  if (background) args.push("--background", background);
  return args;
}

export function buildRulesCheckArgs(filePath, rule) {
  const safePath = validateRelativePath(filePath);
  const args = ["rules", "check"];
  if (rule) args.push("--rule", validateRelativePath(rule, "rule"));
  args.push(safePath);
  return args;
}

export function buildRuleArgs(paths, rule) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("paths must contain at least one reviewable file");
  }
  const safePaths = paths.map((p) => validateRelativePath(p));
  const args = ["delegate", "rule", "--format", "json"];
  if (rule) args.push("--rule", validateRelativePath(rule, "rule"));
  args.push(...safePaths);
  return args;
}

export function buildDiffArgs({ mode, filePath, mergeBase, to, commit, workspaceSource }) {
  const safePath = validateRelativePath(filePath);
  switch (mode) {
    case "range":
      return {
        command: "git",
        args: ["diff", `${validateRef(mergeBase, "merge_base")}..${validateRef(to, "to")}`, "--", safePath],
        kind: "diff"
      };
    case "commit":
      return {
        command: "git",
        args: ["show", "--format=", validateRef(commit, "commit"), "--", safePath],
        kind: "diff"
      };
    case "workspace":
      if (workspaceSource === "untracked") {
        return { command: null, args: [], kind: "file", path: safePath };
      }
      if (workspaceSource !== "tracked") {
        throw new Error("workspace mode requires workspaceSource=tracked|untracked");
      }
      return { command: "git", args: ["diff", "HEAD", "--", safePath], kind: "diff" };
    default:
      throw new Error(`unsupported mode: ${mode}`);
  }
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
  configuredRoot = configuredRoot ?? process.env.OCR_REPO ?? process.cwd();
  const absolute = path.resolve(configuredRoot);
  const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: absolute });
  return (await realpath(result.stdout.trim())).replace(/[\\/]$/, "");
}

export async function resolveSafeExistingPath(repoRoot, relativePath) {
  const safeRelative = validateRelativePath(relativePath);
  const repoReal = await realpath(repoRoot);
  const candidateReal = await realpath(path.resolve(repoReal, safeRelative));
  const prefix = `${repoReal}${path.sep}`;
  if (candidateReal !== repoReal && !candidateReal.startsWith(prefix)) {
    throw new Error("resolved path escapes repository root (possible symlink escape)");
  }
  return { absolute: candidateReal, relative: safeRelative };
}

export async function readRepoFile(repoRoot, relativePath, startLine, endLine) {
  const { absolute, relative } = await resolveSafeExistingPath(repoRoot, relativePath);
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) throw new Error("binary files are not supported by repo_read_file");
  const text = buffer.toString("utf8");
  if (startLine == null && endLine == null) return { path: relative, content: text };

  const lines = text.split(/\r?\n/);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? lines.length);
  if (end < start) throw new Error("end_line must be greater than or equal to start_line");
  return { path: relative, start_line: start, end_line: end, content: lines.slice(start - 1, end).join("\n") };
}

export async function checkAdapterHealth(repoRoot) {
  const git = await runCommand("git", ["--version"], { cwd: repoRoot });
  const ocr = await runCommand("ocr", ["--version"], { cwd: repoRoot });
  const previewHelp = await runCommand("ocr", ["delegate", "preview", "--help"], { cwd: repoRoot });
  const ruleHelp = await runCommand("ocr", ["delegate", "rule", "--help"], { cwd: repoRoot });
  const scanHelp = await runCommand("ocr", ["scan", "--help"], { cwd: repoRoot });
  const rulesCheckHelp = await runCommand("ocr", ["rules", "check", "--help"], { cwd: repoRoot });
  const previewFormat = /--format/.test(previewHelp.stdout + previewHelp.stderr);
  const ruleFormat = /--format/.test(ruleHelp.stdout + ruleHelp.stderr);
  const scanPreviewFormat = /--preview/.test(scanHelp.stdout + scanHelp.stderr) && /--format/.test(scanHelp.stdout + scanHelp.stderr);
  const rulesCheckSupported = /<file-path>/.test(rulesCheckHelp.stdout + rulesCheckHelp.stderr);
  return {
    ok: previewFormat && ruleFormat && scanPreviewFormat && rulesCheckSupported,
    repo_root: repoRoot,
    git_version: git.stdout.trim(),
    ocr_version: ocr.stdout.trim(),
    delegate_preview_json_supported: previewFormat,
    delegate_rule_json_supported: ruleFormat,
    scan_preview_json_supported: scanPreviewFormat,
    rules_check_supported: rulesCheckSupported
  };
}

/**
 * Extract the absolute repository root from a target-provider's resolved
 * descriptor (`@majiwari/registry`'s `resolve()` output, adapter-defined
 * shape). OCR's own convention is `{ repoRoot: "<absolute path>" }`; anything
 * else -- missing, non-string, relative, empty -- fails closed instead of
 * ever reaching git/OCR/filesystem access with an unusable value.
 */
export function extractDescriptorRepoRoot(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("resolved target descriptor is malformed");
  }
  const { repoRoot } = descriptor;
  if (typeof repoRoot !== "string" || repoRoot.length === 0 || !path.isAbsolute(repoRoot)) {
    throw new Error("resolved target descriptor must identify an absolute repository root");
  }
  return repoRoot;
}

export function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error.message}`);
  }
}
