import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildGetArgs,
  buildIssueCreateArgs,
  buildPullRequestCreateArgs,
  buildTemplateSchemaArgs,
  buildValidateArgs,
  checkAdapterHealth,
  parseServerArgs,
  resolveRepoRoot,
  runInari
} from "./core.js";

const cli = parseServerArgs(process.argv.slice(2));
if (cli.help) {
  process.stdout.write(`Inari MCP adapter\n\nUsage:\n  node src/server.js [--repo /absolute/path/to/repository]\n\nEnvironment:\n  INARI_REPO                fallback repository path\n  INARI_ADAPTER_TIMEOUT_MS   command timeout (default 30000)\n  INARI_ADAPTER_MAX_BUFFER   max command output bytes (default 10485760)\n`);
  process.exit(0);
}

const repoRoot = await resolveRepoRoot(cli.repo);

const server = new McpServer(
  { name: "inari-adapter", version: "0.1.0" },
  {
    instructions: [
      "This server maps MCP tool calls to Inari (gh-inari), a governed GitHub CLI for repository Issue/PR templates.",
      "Inari remains authoritative for template governance, semantic validation, and rendering. This adapter performs argument translation, process invocation, and result normalization only -- it never re-implements a governance rule.",
      "For template discovery, call inari_template_list first, then inari_issue_schema / inari_pr_schema for the selected template's field contract.",
      "For an existing Issue or PR, use inari_issue_get / inari_pr_get to read its canonical fields, or inari_issue_validate / inari_pr_validate (by number) to classify it without reading fields.",
      "Before creating an Issue or PR, validate the intended fields with inari_issue_validate / inari_pr_validate (template + fields, no number) so validation failures surface before a GitHub mutation is attempted.",
      "inari_issue_create / inari_pr_create perform a governed mutation: Inari validates and renders the artifact and only then calls GitHub. A validation failure is returned as a structured result, not a crash.",
      "Call adapter_health first to confirm Inari is installed, protocol-compatible, and GitHub authentication is available before attempting any of the above."
    ].join(" ")
  }
);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

function result(data, summary) {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary ?? JSON.stringify(data) }]
  };
}

const fieldsSchema = z
  .record(z.union([z.string(), z.array(z.string()).max(50)]))
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 200, {
    message: "fields must contain between 1 and 200 entries"
  });

server.registerTool(
  "adapter_health",
  {
    title: "Check Inari adapter",
    description: "Verify Inari's protocol/capability compatibility and GitHub authentication prerequisites before calling any other tool. Never returns credential values or the host's local filesystem paths.",
    inputSchema: {},
    outputSchema: {
      ok: z.boolean(),
      inari_version: z.string().optional(),
      inari_protocol: z.number().optional(),
      inari_capabilities: z.array(z.string()).optional(),
      inari_compatible: z.boolean(),
      github_authenticated: z.boolean(),
      detail: z.string().optional()
    },
    annotations: READ_ONLY
  },
  async () => {
    // repo_root is an absolute host filesystem path -- local diagnostic
    // detail, never returned on this remote MCP surface (kept in
    // doctor.js's own local-only output instead).
    const { repo_root: _repoRoot, ...data } = await checkAdapterHealth(repoRoot);
    return result(data, data.ok ? "Inari adapter is ready." : "Inari or GitHub authentication is not ready.");
  }
);

server.registerTool(
  "inari_template_list",
  {
    title: "List Inari-governed templates",
    description: "Discover repository-native and semantic Issue/PR templates that Inari governs. Always call this (or inari_issue_schema / inari_pr_schema) before creating an Issue or PR with an unfamiliar template.",
    inputSchema: {},
    outputSchema: {
      templates: z.array(z.unknown()).optional(),
      semanticTemplates: z.array(z.unknown()).optional(),
      ok: z.boolean().optional(),
      error: z.unknown().optional()
    },
    annotations: READ_ONLY
  },
  async () => {
    const data = await runInari(["template", "list", "--json"], { cwd: repoRoot, label: "inari template list" });
    return result(data, `Discovered ${Array.isArray(data.templates) ? data.templates.length : 0} template(s).`);
  }
);

function registerSchemaTool(domain, name, title) {
  server.registerTool(
    name,
    {
      title,
      description: `Resolve Inari's canonical field schema for one ${domain === "issue" ? "Issue" : "pull request"} template. Inari is authoritative for which fields exist and are required.`,
      inputSchema: { template: z.string().min(1), compact: z.boolean().optional() },
      outputSchema: {
        contract: z.unknown().optional(),
        template: z.unknown().optional(),
        schema: z.unknown().optional(),
        ok: z.boolean().optional(),
        error: z.unknown().optional()
      },
      annotations: READ_ONLY
    },
    async ({ template, compact }) => {
      const data = await runInari(buildTemplateSchemaArgs(domain, template, { compact }), {
        cwd: repoRoot,
        label: `inari ${domain} schema`
      });
      return result(data, `Resolved the "${template}" ${domain} schema.`);
    }
  );
}

function registerGetTool(domain, name, title) {
  server.registerTool(
    name,
    {
      title,
      description: `Read the canonical fields of an existing ${domain === "issue" ? "Issue" : "pull request"} that matches Inari's governed template contract. Reports structured diagnostics instead of guessed fields when the artifact does not match.`,
      inputSchema: { number: z.number().int().positive(), template: z.string().min(1).optional() },
      outputSchema: {
        valid: z.boolean().optional(),
        projection: z.string().optional(),
        classification: z.string().optional(),
        kind: z.string().optional(),
        number: z.number().optional(),
        url: z.string().optional(),
        template: z.unknown().optional(),
        metadata: z.unknown().optional(),
        fields: z.unknown().optional(),
        diagnostics: z.unknown().optional(),
        ok: z.boolean().optional(),
        error: z.unknown().optional()
      },
      annotations: READ_ONLY
    },
    async ({ number, template }) => {
      const data = await runInari(buildGetArgs(domain, number, template), { cwd: repoRoot, label: `inari ${domain} get` });
      return result(data, data.valid ? `Read ${domain} #${number}.` : `${domain} #${number} did not resolve to a canonical projection.`);
    }
  );
}

function registerValidateTool(domain, name, title) {
  server.registerTool(
    name,
    {
      title,
      description: `Validate an existing ${domain === "issue" ? "Issue" : "pull request"} by number, or validate new field content against a template before creating one. Provide either "number" (existing artifact) or "template" + "fields" (new content), not both.`,
      inputSchema: {
        number: z.number().int().positive().optional(),
        template: z.string().min(1).optional(),
        fields: fieldsSchema.optional()
      },
      outputSchema: {
        valid: z.boolean().optional(),
        classification: z.string().optional(),
        number: z.number().optional(),
        url: z.string().optional(),
        diagnostics: z.unknown().optional(),
        violations: z.unknown().optional(),
        values: z.unknown().optional(),
        missingFields: z.unknown().optional(),
        invalidFields: z.unknown().optional(),
        ok: z.boolean().optional(),
        error: z.unknown().optional()
      },
      annotations: READ_ONLY
    },
    async ({ number, template, fields }) => {
      if (number !== undefined && (template !== undefined || fields !== undefined)) {
        throw new Error('provide either "number" or "template" + "fields", not both');
      }
      const data = await runInari(buildValidateArgs(domain, { number, template, fields }), {
        cwd: repoRoot,
        label: `inari ${domain} validate`
      });
      return result(data, data.valid ? "Valid." : "Not valid; see violations.");
    }
  );
}

registerSchemaTool("issue", "inari_issue_schema", "Resolve Inari Issue template schema");
registerSchemaTool("pr", "inari_pr_schema", "Resolve Inari pull request template schema");
registerGetTool("issue", "inari_issue_get", "Read an existing Inari-governed Issue");
registerGetTool("pr", "inari_pr_get", "Read an existing Inari-governed pull request");
registerValidateTool("issue", "inari_issue_validate", "Validate an Inari-governed Issue");
registerValidateTool("pr", "inari_pr_validate", "Validate an Inari-governed pull request");

server.registerTool(
  "inari_issue_create",
  {
    title: "Create an Inari-governed Issue",
    description: "Create a new Issue through Inari: fields are validated against the template's governed schema and rendered to canonical Markdown before GitHub is called. A validation failure returns a structured result rather than a partially-formed Issue.",
    inputSchema: { template: z.string().min(1), fields: fieldsSchema, title: z.string().min(1).optional() },
    outputSchema: { ok: z.boolean().optional(), artifact: z.unknown().optional(), governance: z.unknown().optional(), error: z.unknown().optional() },
    annotations: WRITE
  },
  async ({ template, fields, title }) => {
    const data = await runInari(buildIssueCreateArgs(template, fields, { title }), { cwd: repoRoot, label: "inari issue create" });
    return result(data, data.ok ? `Created Issue #${data.artifact?.number}.` : "Issue creation failed validation.");
  }
);

server.registerTool(
  "inari_pr_create",
  {
    title: "Create an Inari-governed pull request",
    description: "Create a new pull request through Inari: fields are validated against the template's governed schema and rendered to canonical Markdown before GitHub is called. A validation failure returns a structured result rather than a partially-formed pull request.",
    inputSchema: {
      template: z.string().min(1),
      fields: fieldsSchema,
      title: z.string().min(1).optional(),
      head: z.string().min(1).optional(),
      base: z.string().min(1).optional(),
      draft: z.boolean().optional(),
      maintainerCanModify: z.boolean().optional()
    },
    outputSchema: { ok: z.boolean().optional(), artifact: z.unknown().optional(), governance: z.unknown().optional(), error: z.unknown().optional() },
    annotations: WRITE
  },
  async ({ template, fields, title, head, base, draft, maintainerCanModify }) => {
    const data = await runInari(buildPullRequestCreateArgs(template, fields, { title, head, base, draft, maintainerCanModify }), {
      cwd: repoRoot,
      label: "inari pr create"
    });
    return result(data, data.ok ? `Created pull request #${data.artifact?.number}.` : "Pull request creation failed validation.");
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
