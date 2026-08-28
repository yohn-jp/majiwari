import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { targetIdSchema } from "@majiwari/registry";

export const RESIDENT_CONFIG_VERSION = 1;
export const DEFAULT_RESIDENT_PORT = 8787;
export const DEFAULT_RESIDENT_CONFIG_FILE = "majiwari.runtime.json";

function absolutePathSchema(label) {
  return z
    .string()
    .min(1, `${label} is required`)
    .refine((value) => path.isAbsolute(value), `${label} must be an absolute path`)
    .refine((value) => !value.includes("\0") && !/[\r\n]/u.test(value), `${label} contains unsafe characters`);
}

const repoPathSchema = absolutePathSchema("repo");

const enabledSingleRepoAdapterSchema = z
  .object({
    enabled: z.literal(true),
    repo: repoPathSchema
  })
  .strict();

// A second, generic shape for "enabled": a static list of named targets
// (id + absolute repo path) instead of one fixed repo. Config stays
// adapter-agnostic here -- it is only "repo, or a list of id/repo pairs";
// what an adapter *does* with `targets` (or whether it supports the field
// at all) is decided at the trusted composition edge (`catalog.js`), not
// here. This is the seam #29's fixture/local target-provider smoke uses;
// it carries no Mottainai-specific (#30/#45) discovery of its own.
const enabledMultiTargetAdapterSchema = z
  .object({
    enabled: z.literal(true),
    targets: z
      .array(
        z
          .object({
            id: targetIdSchema,
            repo: repoPathSchema
          })
          .strict()
      )
      .min(1, "targets must contain at least one entry")
      .refine((targets) => new Set(targets.map((target) => target.id)).size === targets.length, "target ids must be unique")
  })
  .strict();

// A third, adapter-agnostic-in-shape "enabled" variant (#30): instead of a
// fixed repo or a static targets list, delegate discovery to the real
// Mottainai CLI. `command`/`cwd` are the only knobs -- no registry file, no
// Manager URL, no filesystem root to scan -- because the provider itself
// (adapters/open-code-review/src/mottainai-target-provider.js) only ever
// shells out to Mottainai's own public `task list`/`task status` contract.
// Same as `targets`, whether an adapter id actually supports `mottainai` is
// decided at the trusted composition edge (catalog.js), not here.
const enabledMottainaiAdapterSchema = z
  .object({
    enabled: z.literal(true),
    mottainai: z
      .object({
        command: z.string().min(1).optional(),
        cwd: repoPathSchema.optional()
      })
      .strict()
  })
  .strict();

const disabledAdapterSchema = z
  .object({
    enabled: z.literal(false)
  })
  .strict();

const adapterConfigSchema = z.union([enabledSingleRepoAdapterSchema, enabledMultiTargetAdapterSchema, enabledMottainaiAdapterSchema, disabledAdapterSchema]);

// The trusted built-in `mottainai` gateway adapter (#56): a closed, distinct
// shape from `adapterConfigSchema` above -- it never accepts `repo`/
// `targets`, since it launches Mottainai's own packaged `mottainai-mcp`
// entrypoint rather than being bound to a Git checkout. `config`, when
// given, is the one optional selector that entrypoint's own public launch
// contract documents (`--config <path>`, yohn-jp/mottainai#548). No
// executable/argument/environment/module field is accepted here -- the
// trusted composition edge (`catalog.js`) is the only place allowed to
// choose what actually runs.
const enabledMottainaiMcpAdapterSchema = z
  .object({
    enabled: z.literal(true),
    config: absolutePathSchema("config").optional()
  })
  .strict();

const mottainaiMcpAdapterConfigSchema = z.union([enabledMottainaiMcpAdapterSchema, disabledAdapterSchema]);

const adaptersSchema = z
  .object({
    "open-code-review": adapterConfigSchema.optional(),
    inari: adapterConfigSchema.optional(),
    mottainai: mottainaiMcpAdapterConfigSchema.optional()
  })
  .strict();

const residentConfigSchema = z
  .object({
    version: z.literal(RESIDENT_CONFIG_VERSION, {
      message: `version must be ${RESIDENT_CONFIG_VERSION}`
    }),
    port: z.number().int("port must be an integer").min(1, "port must be between 1 and 65535").max(65535, "port must be between 1 and 65535").optional(),
    adapters: adaptersSchema.optional()
  })
  .strict();

export class ResidentConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ResidentConfigError";
  }
}

function formatIssues(error) {
  return error.issues
    .map((issue) => {
      const field = issue.path.length ? issue.path.join(".") : "(config)";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Validate and normalize the closed resident configuration contract.
 * Validation is deliberately independent of filesystem/process/network
 * access so callers can reject a bad config before creating runtime state.
 */
export function parseResidentConfig(value) {
  const parsed = residentConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ResidentConfigError(`invalid resident config: ${formatIssues(parsed.error)}`);
  }

  return {
    version: RESIDENT_CONFIG_VERSION,
    port: parsed.data.port ?? DEFAULT_RESIDENT_PORT,
    adapters: {
      ...(parsed.data.adapters ?? {})
    }
  };
}

/** Load JSON and then apply the same closed schema as in-memory callers. */
export async function loadResidentConfig(filePath = DEFAULT_RESIDENT_CONFIG_FILE) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    throw new ResidentConfigError("cannot read resident config file");
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ResidentConfigError("resident config file must contain valid JSON");
  }
  return parseResidentConfig(value);
}

export function enabledResidentAdapters(config) {
  const normalized = parseResidentConfig(config);
  return ["open-code-review", "inari", "mottainai"]
    .filter((id) => normalized.adapters[id]?.enabled === true)
    .map((id) => {
      const adapter = normalized.adapters[id];
      if (id === "mottainai") return { id, ...(adapter.config !== undefined && { config: adapter.config }) };
      if ("targets" in adapter) return { id, targets: adapter.targets };
      if ("mottainai" in adapter) return { id, mottainai: adapter.mottainai };
      return { id, repo: adapter.repo };
    });
}
