import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildDiffArgs,
  buildPreviewArgs,
  buildRuleArgs,
  buildRulesCheckArgs,
  buildScanPreviewArgs,
  checkAdapterHealth,
  parseJson,
  readRepoFile,
  runCommand,
  validateRelativePath
} from "./core.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

function result(data, summary) {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary ?? JSON.stringify(data) }]
  };
}

/**
 * Replace any occurrence of the just-resolved absolute repository root in a
 * thrown error's message before it can reach an MCP response. Standalone's
 * repoRoot is local operator configuration, not a secret, but a managed
 * caller only ever knows its own opaque targetId -- a command's stderr
 * (e.g. an `ocr`/`git` invocation echoing back its own `--repo` argument)
 * must never turn that into the real filesystem path behind it.
 */
function redactRepoRoot(error, repoRoot) {
  const message = error instanceof Error ? error.message : String(error);
  if (!repoRoot || !message.includes(repoRoot)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(message.split(repoRoot).join("<target>"));
}

/**
 * Build the OCR delegation MCP server's tool surface. Reusable by both the
 * standalone stdio entry point (`server.js`, one fixed repository for the
 * whole process lifetime) and an adapter-local managed transport
 * (`managed-transport.js`, one resident server resolving a fresh repository
 * root per call from a target-provider authority) -- the tool schemas,
 * argument construction, and OCR/git invocation are identical either way;
 * only how a call's repository root is obtained differs.
 *
 * `resolveExecutionContext(targetId)` is called first, before any
 * OCR/git/filesystem access, for every workspace-sensitive tool call and
 * must resolve to that one call's absolute repository root or throw.
 * Nothing here caches the result across calls.
 */
export function createOcrServer({ resolveExecutionContext, healthCwd }) {
  const server = new McpServer(
    { name: "open-code-review-chatgpt-adapter", version: "0.1.0" },
    {
      instructions: [
        "This server is a read-only host adapter for Alibaba OpenCodeReview (OCR) Delegation Mode.",
        "OCR is authoritative for deterministic review scope and rule resolution. The host model performs only the review reasoning delegated by OCR.",
        "For a diff/range/commit review: call adapter_health first; call ocr_delegate_preview exactly once for the requested workspace/range/commit target; resolve OCR rules for every previewed reviewable file; read every selected diff via repo_diff.",
        "For a general/full-file review of a repository or directory (no diff target): call adapter_health first; call scan_delegate_preview exactly once for the requested path (omit path for the whole repository); resolve OCR rules for every previewed reviewable file; read the full content of every selected file via repo_read_file.",
        "Use ocr_rules_check to debug why a single file was included/excluded or which rule layer applies to it. Use repo_read_file/repo_search only for needed context.",
        "Account for every previewed entry as reviewed or skipped with a concrete reason.",
        "Do not call OCR-managed LLM review (ocr review / ocr scan without --preview), and do not mutate the repository through this adapter.",
        "Report findings with path/content and optional start_line/end_line/category/severity, plus total/reviewed/skipped counts and coverage_rate.",
        "In managed mode, every workspace-sensitive tool requires targetId; carry the same targetId across a whole delegated workflow (preview, rules, diff/read/search, rules check). Never infer or remember it from an earlier call."
      ].join(" ")
    }
  );

  /**
   * Wrap a workspace-sensitive tool handler so its targetId is resolved to
   * that call's repository root immediately, before `handler` runs any
   * OCR/git/filesystem access, and so its errors never leak that root.
   */
  function withTarget(handler) {
    return async (input) => {
      const { targetId, ...rest } = input ?? {};
      const repoRoot = await resolveExecutionContext(targetId);
      try {
        return await handler(rest, repoRoot);
      } catch (error) {
        throw redactRepoRoot(error, repoRoot);
      }
    };
  }

  server.registerTool(
    "adapter_health",
    {
      title: "Check OCR delegation adapter",
      description: "Verify the configured repository, Git, OCR CLI, and delegation JSON support before starting a delegated review.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        git_version: z.string(),
        ocr_version: z.string(),
        delegate_preview_json_supported: z.boolean(),
        delegate_rule_json_supported: z.boolean(),
        scan_preview_json_supported: z.boolean(),
        rules_check_supported: z.boolean()
      },
      annotations: READ_ONLY
    },
    async () => {
      // adapter_health is process/adapter health, not workspace selection
      // (#29): it never takes targetId and never resolves a managed target.
      const { repo_root: _repoRoot, ...data } = await checkAdapterHealth(healthCwd);
      return result(data, data.ok ? "OCR delegation adapter is ready." : "OCR is present, but full support was not detected for delegate preview/rule, scan preview, and rules check.");
    }
  );

  server.registerTool(
    "ocr_delegate_preview",
    {
      title: "Preview OCR delegated review scope",
      description: "Call OCR delegation preview to deterministically select reviewable files and return workspace/range/commit metadata. Always call this first for a delegated review.",
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
        commit: z.string().optional(),
        exclude: z.string().optional(),
        background: z.string().optional(),
        targetId: z.string().optional()
      },
      outputSchema: {
        preview: z
          .object({
            schema_version: z.string(),
            reviewable_files: z.array(z.unknown())
          })
          .passthrough()
      },
      annotations: READ_ONLY
    },
    withTarget(async (input, repoRoot) => {
      const args = buildPreviewArgs(input);
      args.push("--repo", repoRoot);
      const completed = await runCommand("ocr", args, { cwd: repoRoot });
      const preview = parseJson(completed.stdout, "ocr delegate preview");
      if (preview.schema_version !== "1") {
        throw new Error(`unsupported OCR delegation schema_version: ${String(preview.schema_version)}`);
      }
      if (!Array.isArray(preview.reviewable_files)) {
        throw new Error("OCR delegation preview is missing reviewable_files");
      }
      return result({ preview }, `OCR selected ${preview.reviewable_files.length} reviewable file entries.`);
    })
  );

  server.registerTool(
    "ocr_delegate_rules",
    {
      title: "Resolve OCR review rules",
      description: "Resolve OCR review rules for reviewable file paths selected by ocr_delegate_preview. OCR remains the authority for rule matching.",
      inputSchema: {
        paths: z.array(z.string()).min(1).max(500),
        rule: z.string().optional(),
        targetId: z.string().optional()
      },
      outputSchema: {
        rules: z.unknown()
      },
      annotations: READ_ONLY
    },
    withTarget(async ({ paths, rule }, repoRoot) => {
      const args = buildRuleArgs(paths, rule);
      args.splice(4, 0, "--repo", repoRoot);
      const completed = await runCommand("ocr", args, { cwd: repoRoot });
      const rules = parseJson(completed.stdout, "ocr delegate rule");
      return result({ rules }, "OCR review rules resolved.");
    })
  );

  server.registerTool(
    "scan_delegate_preview",
    {
      title: "Preview OCR full-file scan scope",
      description: "Call OCR full-file scan preview to deterministically select files for a whole-repository or whole-directory review (no diff required, no LLM call). Use this instead of ocr_delegate_preview when the request is a general/full-file review rather than a diff review.",
      inputSchema: {
        path: z.string().optional(),
        exclude: z.string().optional(),
        background: z.string().optional(),
        targetId: z.string().optional()
      },
      outputSchema: {
        scan: z
          .object({
            files: z.array(z.unknown()),
            total_files: z.number(),
            reviewable_count: z.number(),
            excluded_count: z.number()
          })
          .passthrough()
      },
      annotations: READ_ONLY
    },
    withTarget(async (input, repoRoot) => {
      const args = buildScanPreviewArgs(input);
      args.push("--repo", repoRoot);
      const completed = await runCommand("ocr", args, { cwd: repoRoot });
      const scan = parseJson(completed.stdout, "ocr scan --preview");
      if (!Array.isArray(scan.files)) {
        throw new Error("OCR scan preview is missing files");
      }
      return result({ scan }, `OCR selected ${scan.reviewable_count ?? scan.files.length} of ${scan.total_files ?? scan.files.length} scannable file entries.`);
    })
  );

  server.registerTool(
    "ocr_rules_check",
    {
      title: "Check OCR review rule for one file",
      description: "Show which OCR review rule layer and pattern applies to a single repository-relative file path. Useful for debugging why a file was included/excluded or which standard it is held to.",
      inputSchema: {
        path: z.string(),
        rule: z.string().optional(),
        targetId: z.string().optional()
      },
      outputSchema: {
        output: z.string()
      },
      annotations: READ_ONLY
    },
    withTarget(async ({ path: filePath, rule }, repoRoot) => {
      const args = buildRulesCheckArgs(filePath, rule);
      args.splice(2, 0, "--repo", repoRoot);
      const completed = await runCommand("ocr", args, { cwd: repoRoot });
      return result({ output: completed.stdout }, `Resolved OCR rule for ${filePath}.`);
    })
  );

  server.registerTool(
    "repo_diff",
    {
      title: "Read one delegated review diff",
      description: "Read the exact diff/full-file content for one OCR reviewable entry. Inputs must come from OCR preview metadata. For workspace mode, identify tracked versus untracked from the preview entry status.",
      inputSchema: {
        mode: z.enum(["workspace", "range", "commit"]),
        path: z.string(),
        merge_base: z.string().optional(),
        to: z.string().optional(),
        commit: z.string().optional(),
        workspace_source: z.enum(["tracked", "untracked"]).optional(),
        targetId: z.string().optional()
      },
      outputSchema: {
        kind: z.enum(["file", "diff"]),
        path: z.string(),
        content: z.string()
      },
      annotations: READ_ONLY
    },
    withTarget(async ({ mode, path: filePath, merge_base: mergeBase, to, commit, workspace_source: workspaceSource }, repoRoot) => {
      const spec = buildDiffArgs({ mode, filePath, mergeBase, to, commit, workspaceSource });
      if (spec.kind === "file") {
        const file = await readRepoFile(repoRoot, spec.path);
        return result({ kind: "file", ...file }, `Read untracked file ${file.path}.`);
      }
      const completed = await runCommand(spec.command, spec.args, { cwd: repoRoot });
      return result({ kind: "diff", path: validateRelativePath(filePath), content: completed.stdout }, `Read diff for ${filePath}.`);
    })
  );

  server.registerTool(
    "repo_read_file",
    {
      title: "Read repository file context",
      description: "Read an existing repository file or bounded line range when additional context is required during an OCR delegated review.",
      inputSchema: {
        path: z.string(),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        targetId: z.string().optional()
      },
      outputSchema: {
        path: z.string(),
        content: z.string(),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional()
      },
      annotations: READ_ONLY
    },
    withTarget(async ({ path: filePath, start_line: startLine, end_line: endLine }, repoRoot) => {
      const file = await readRepoFile(repoRoot, filePath, startLine, endLine);
      return result(file, `Read ${file.path}${file.start_line ? ` lines ${file.start_line}-${file.end_line}` : ""}.`);
    })
  );

  server.registerTool(
    "repo_search",
    {
      title: "Search repository context",
      description: "Run fixed-string read-only git grep within the configured repository to locate definitions/usages needed for an OCR delegated review.",
      inputSchema: {
        query: z.string().min(1),
        paths: z.array(z.string()).max(50).optional(),
        targetId: z.string().optional()
      },
      outputSchema: {
        matches: z.string(),
        found: z.boolean()
      },
      annotations: READ_ONLY
    },
    withTarget(async ({ query, paths = [] }, repoRoot) => {
      if (query.includes("\0") || /[\r\n]/.test(query)) throw new Error("query contains unsafe characters");
      const safePaths = paths.map((p) => validateRelativePath(p));
      const args = ["grep", "-n", "-F", "-e", query];
      if (safePaths.length) args.push("--", ...safePaths);
      const completed = await runCommand("git", args, { cwd: repoRoot, allowExitCodes: [0, 1] });
      return result({ matches: completed.stdout, found: completed.exitCode === 0 }, completed.exitCode === 0 ? "Repository matches found." : "No matches found.");
    })
  );

  return server;
}
