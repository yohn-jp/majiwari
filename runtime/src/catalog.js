import path from "node:path";
import { createManifest as createOpenCodeReviewManifest } from "@majiwari/adapter-open-code-review/src/manifest.js";
import { createManifest as createInariManifest } from "@majiwari/adapter-inari/src/manifest.js";
import { enabledResidentAdapters, parseResidentConfig } from "./config.js";

export const TRUSTED_RESIDENT_ADAPTER_IDS = Object.freeze(["open-code-review", "inari"]);

/**
 * The only factories reachable from the CLI's resident config. User config
 * selects an id and repository path; it never selects executable/module/URL
 * material. Adapter-specific selection stays at this composition edge.
 */
export const TRUSTED_RESIDENT_CATALOG = Object.freeze({
  // Resident child stderr is intentionally ignored: adapter diagnostics are
  // not a public status channel and may contain local filesystem paths.
  "open-code-review": ({ repo }) => createOpenCodeReviewManifest({ repo, stderr: "ignore" }),
  inari: ({ repo }) => createInariManifest({ repo, stderr: "ignore" })
});

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function redactedText(value, repo) {
  if (typeof value !== "string") return value;
  const candidates = [...new Set([repo, path.normalize(repo), path.resolve(repo)])]
    .filter((candidate) => candidate && candidate !== path.parse(candidate).root)
    .sort((left, right) => right.length - left.length);
  return candidates.reduce((result, candidate) => result.replaceAll(candidate, "<configured-repository>"), value);
}

function redactValue(value, repo) {
  if (typeof value === "string") return redactedText(value, repo);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, repo));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, repo)]));
  }
  return value;
}

/** Make resident-facing hook errors and generic health/tool projections path-safe. */
export function protectManifestForResident(manifest, repo) {
  const wrap = (hook, { redactResult = false } = {}) => {
    if (typeof hook !== "function") return hook;
    return async (...args) => {
      try {
        const result = await hook(...args);
        return redactResult ? redactValue(result, repo) : result;
      } catch (error) {
        throw new Error(redactedText(errorText(error), repo));
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
  return enabledResidentAdapters(normalized).map(({ id, repo }) => {
    const factory = catalog[id];
    if (typeof factory !== "function") {
      throw new Error(`resident catalog has no trusted factory for adapter "${id}"`);
    }
    const manifest = factory({ repo });
    if (!manifest || manifest.id !== id) {
      throw new Error(`resident catalog factory returned the wrong manifest for adapter "${id}"`);
    }
    return { id, repo, manifest: protectManifestForResident(manifest, repo) };
  });
}

export function redactResidentError(error, repos) {
  const message = repos.reduce((result, repo) => redactedText(result, repo), errorText(error));
  return new Error(message);
}
