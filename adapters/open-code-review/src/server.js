import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildDiffArgs,
  buildPreviewArgs,
  buildRuleArgs,
  parseJson,
  parseServerArgs,
  readRepoFile,
  resolveRepoRoot,
  runCommand,
  validateRelativePath
} from "./core.js";

const cli = parseServerArgs(process.argv.slice(2));
if (cli.help) {
  process.stdout.write(`OpenCodeReview ChatGPT MCP adapter\n\nUsage:\n  node src/server.js [--repo /absolute/path/to/repository]\n\nEnvironment:\n  OCR_REPO                 fallback repository path\n  OCR_ADAPTER_TIMEOUT_MS   command timeout (default 30000)\n  OCR_ADAPTER_MAX_BUFFER   max command output bytes (default 10485760)\n`);
  process.exit(0);
}

const repoRoot = await resolveRepoRoot(cli.repo);

const server = new McpServer(
  { name: "open-code-review-chatgpt-adapter", version: "0.1.0" },
  {
    instructions: [
      "This server is a read-only host adapter for Alibaba OpenCodeReview (OCR) Delegation Mode.",
      "OCR is authoritative for deterministic review scope and rule resolution. The host model performs only the review reasoning delegated by OCR.",
      "For every review: call adapter_health first; call ocr_delegate_preview exactly once for the requested workspace/range/commit target; resolve OCR rules for every previewed reviewable file; read every selected diff; use repo_read_file/repo_search only for needed context; account for every (path,status) entry as reviewed or skipped with a concrete reason.",
      "Do not substitute a generic repository review, do not call OCR-managed LLM review, and do not mutate the repository through this adapter.",
      "Report findings with path/content and optional start_line/end_line/category/severity, plus total/reviewed/skipped counts and coverage_rate."
    ].join(" ")
  }
);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

function result(data, summary) {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary ?? JSON.stringify(data) }]
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
      repo_root: z.string(),
      git_version: z.string(),
      ocr_version: z.string(),
      delegate_preview_json_supported: z.boolean(),
      delegate_rule_json_supported: z.boolean()
    },
    annotations: READ_ONLY
  },
  async () => {
    const git = await runCommand("git", ["--version"], { cwd: repoRoot });
    const ocr = await runCommand("ocr", ["--version"], { cwd: repoRoot });
    const previewHelp = await runCommand("ocr", ["delegate", "preview", "--help"], { cwd: repoRoot });
    const ruleHelp = await runCommand("ocr", ["delegate", "rule", "--help"], { cwd: repoRoot });
    const previewFormat = /--format/.test(previewHelp.stdout + previewHelp.stderr);
    const ruleFormat = /--format/.test(ruleHelp.stdout + ruleHelp.stderr);
    const data = {
      ok: previewFormat && ruleFormat,
      repo_root: repoRoot,
      git_version: git.stdout.trim(),
      ocr_version: ocr.stdout.trim(),
      delegate_preview_json_supported: previewFormat,
      delegate_rule_json_supported: ruleFormat
    };
    return result(data, data.ok ? "OCR delegation adapter is ready." : "OCR is present, but delegation JSON support was not detected for both preview and rule.");
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
      background: z.string().optional()
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
  async (input) => {
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
  }
);

server.registerTool(
  "ocr_delegate_rules",
  {
    title: "Resolve OCR review rules",
    description: "Resolve OCR review rules for reviewable file paths selected by ocr_delegate_preview. OCR remains the authority for rule matching.",
    inputSchema: {
      paths: z.array(z.string()).min(1).max(500),
      rule: z.string().optional()
    },
    outputSchema: {
      rules: z.unknown()
    },
    annotations: READ_ONLY
  },
  async ({ paths, rule }) => {
    const args = buildRuleArgs(paths, rule);
    args.splice(4, 0, "--repo", repoRoot);
    const completed = await runCommand("ocr", args, { cwd: repoRoot });
    const rules = parseJson(completed.stdout, "ocr delegate rule");
    return result({ rules }, "OCR review rules resolved.");
  }
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
      workspace_source: z.enum(["tracked", "untracked"]).optional()
    },
    outputSchema: {
      kind: z.enum(["file", "diff"]),
      path: z.string(),
      content: z.string()
    },
    annotations: READ_ONLY
  },
  async ({ mode, path: filePath, merge_base: mergeBase, to, commit, workspace_source: workspaceSource }) => {
    const spec = buildDiffArgs({ mode, filePath, mergeBase, to, commit, workspaceSource });
    if (spec.kind === "file") {
      const file = await readRepoFile(repoRoot, spec.path);
      return result({ kind: "file", ...file }, `Read untracked file ${file.path}.`);
    }
    const completed = await runCommand(spec.command, spec.args, { cwd: repoRoot });
    return result({ kind: "diff", path: validateRelativePath(filePath), content: completed.stdout }, `Read diff for ${filePath}.`);
  }
);

server.registerTool(
  "repo_read_file",
  {
    title: "Read repository file context",
    description: "Read an existing repository file or bounded line range when additional context is required during an OCR delegated review.",
    inputSchema: {
      path: z.string(),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional()
    },
    outputSchema: {
      path: z.string(),
      content: z.string(),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional()
    },
    annotations: READ_ONLY
  },
  async ({ path: filePath, start_line: startLine, end_line: endLine }) => {
    const file = await readRepoFile(repoRoot, filePath, startLine, endLine);
    return result(file, `Read ${file.path}${file.start_line ? ` lines ${file.start_line}-${file.end_line}` : ""}.`);
  }
);

server.registerTool(
  "repo_search",
  {
    title: "Search repository context",
    description: "Run fixed-string read-only git grep within the configured repository to locate definitions/usages needed for an OCR delegated review.",
    inputSchema: {
      query: z.string().min(1),
      paths: z.array(z.string()).max(50).optional()
    },
    outputSchema: {
      matches: z.string(),
      found: z.boolean()
    },
    annotations: READ_ONLY
  },
  async ({ query, paths = [] }) => {
    if (query.includes("\0") || /[\r\n]/.test(query)) throw new Error("query contains unsafe characters");
    const safePaths = paths.map((p) => validateRelativePath(p));
    const args = ["grep", "-n", "-F", "-e", query];
    if (safePaths.length) args.push("--", ...safePaths);
    const completed = await runCommand("git", args, { cwd: repoRoot, allowExitCodes: [0, 1] });
    return result({ matches: completed.stdout, found: completed.exitCode === 0 }, completed.exitCode === 0 ? "Repository matches found." : "No matches found.");
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
