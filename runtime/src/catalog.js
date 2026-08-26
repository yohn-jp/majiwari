import path from "node:path";
import { createManifest as createOpenCodeReviewManifest, createLocalTargetProvider } from "@majiwari/adapter-open-code-review";
import { createManifest as createInariManifest } from "@majiwari/adapter-inari";
import { enabledResidentAdapters, parseResidentConfig } from "./config.js";

export const TRUSTED_RESIDENT_ADAPTER_IDS = Object.freeze(["open-code-review", "inari"]);

/**
 * The only factories reachable from the CLI's resident config. User config
 * selects an id and repository path(s); it never selects executable/module/
 * URL material. Adapter-specific selection stays at this composition edge.
 *
 * Each factory receives `{ repo }` (single-repository config) or
 * `{ targets }` (a static list of `{ id, repo }` entries, config.js's
 * `targets` shape) depending on which the resident config declared for that
 * adapter id -- see `config.js`. OCR is the only adapter that currently
 * understands `targets`: it builds the injected fixture/local target
 * provider (#26/#29) from it and switches to managed, target-aware
 * execution (`createManifest({ targetProvider })`,
 * `adapters/open-code-review/src/managed-transport.js`) -- one resident
 * adapter process serving every configured targetId, no restart between
 * them, no Mottainai-specific discovery (#30/#45) of any kind. Inari has no
 * such capability and fails closed if `targets` is configured for it.
 */
export const TRUSTED_RESIDENT_CATALOG = Object.freeze({
  // Resident child stderr is intentionally ignored: adapter diagnostics are
  // not a public status channel and may contain local filesystem paths.
  "open-code-review": ({ repo, targets }) =>
    targets
      ? createOpenCodeReviewManifest({
          // config.js's `targets` entries use `repo` (matching this file's
          // single-repository config field); `createLocalTargetProvider`'s
          // own descriptor convention is `repoRoot` -- translate here so
          // neither side has to know the other's field name.
          targetProvider: createLocalTargetProvider(targets.map((target) => ({ id: target.id, repoRoot: target.repo }))),
          stderr: "ignore"
        })
      : createOpenCodeReviewManifest({ repo, stderr: "ignore" }),
  inari: ({ repo, targets }) => {
    if (targets) throw new Error('inari does not support the resident "targets" config; it remains a single-repository adapter');
    return createInariManifest({ repo, stderr: "ignore" });
  }
});

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function repoRedactionCandidates(repos) {
  return [...new Set(repos.flatMap((repo) => [repo, path.normalize(repo), path.resolve(repo)]))]
    .filter((candidate) => candidate && candidate !== path.parse(candidate).root)
    .sort((left, right) => right.length - left.length);
}

function redactedText(value, repos) {
  if (typeof value !== "string") return value;
  return repoRedactionCandidates(repos).reduce((result, candidate) => result.replaceAll(candidate, "<configured-repository>"), value);
}

function redactValue(value, repos) {
  if (typeof value === "string") return redactedText(value, repos);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, repos));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, repos)]));
  }
  return value;
}

/** Every configured repository path for one adapter entry (`{ repo }` or `{ targets }`), for redaction. */
function entryRepos(entry) {
  return entry.targets ? entry.targets.map((target) => target.repo) : [entry.repo];
}

/** Make resident-facing hook errors and generic health/tool projections path-safe. */
export function protectManifestForResident(manifest, repos) {
  const repoList = Array.isArray(repos) ? repos : [repos];
  const wrap = (hook, { redactResult = false } = {}) => {
    if (typeof hook !== "function") return hook;
    return async (...args) => {
      try {
        const result = await hook(...args);
        return redactResult ? redactValue(result, repoList) : result;
      } catch (error) {
        throw new Error(redactedText(errorText(error), repoList));
      }
    };
  };

  return {
    ...manifest,
    transport: {
      ...manifest.transport,
      start: wrap(manifest.transport.start),
      ...(manifest.transport.stop ? { stop: wrap(manifest.transport.stop) } : {})
    },
    ...(manifest.health ? { health: wrap(manifest.health, { redactResult: true }) } : {}),
    ...(manifest.listTools ? { listTools: wrap(manifest.listTools, { redactResult: true }) } : {})
  };
}

/**
 * Build only the configured trusted manifests. The optional catalog argument
 * is an in-process test seam; the CLI always uses TRUSTED_RESIDENT_CATALOG.
 */
export function createConfiguredManifests(config, { catalog = TRUSTED_RESIDENT_CATALOG } = {}) {
  const normalized = parseResidentConfig(config);
  return enabledResidentAdapters(normalized).map((entry) => {
    const { id } = entry;
    const factory = catalog[id];
    if (typeof factory !== "function") {
      throw new Error(`resident catalog has no trusted factory for adapter "${id}"`);
    }
    const manifest = factory(entry);
    if (!manifest || manifest.id !== id) {
      throw new Error(`resident catalog factory returned the wrong manifest for adapter "${id}"`);
    }
    return { ...entry, manifest: protectManifestForResident(manifest, entryRepos(entry)) };
  });
}

export function redactResidentError(error, repos) {
  return new Error(redactedText(errorText(error), repos));
}
