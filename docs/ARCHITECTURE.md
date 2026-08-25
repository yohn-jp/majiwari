# Architecture

## Principle

Majiwari turns existing tools into deterministic MCP adapters and exposes them remotely through a transport layer that shares no domain logic with any one adapter.

> Adapters know what a tool means. The gateway knows only what MCP transport means.

OpenCodeReview (OCR) delegation is the first adapter, not the platform's purpose. OCR remains authoritative for deterministic review engineering (file selection, exclusions, rule resolution) -- the adapter's job is only to turn OCR's CLI into MCP tools without changing that behavior.

## Design principles

1. **Deterministic first.** CLI argument construction, JSON parsing, schema validation, target selection, bounded reads, and error normalization are handled deterministically by the adapter/tool layer -- never left to LLM judgment.
2. **LLM only for irreducible reasoning.** Intent judgment, evaluation, review, and prioritization are delegated to the host LLM through a Skill, and only for what cannot be reduced to a deterministic decision.
3. **Adapter is the product artifact.** Until an adapter is complete, its wrapped tool is not usable from an MCP client. An adapter bundles its tool schemas, tests, and (if needed) a Skill.
4. **No raw shell as a capability.** No adapter exposes "run an arbitrary command" as an MCP tool. Each adapter has an explicit tool surface, allowlist, and schema.
5. **Transparent remote gateway.** The stdio-to-remote transport layer does not know what any tool means. It never changes a tool name, schema, or result. It handles transport and deployment concerns only.
6. **Repository as initial registry.** There is no separate adapter registry in v0. A pull request adding an adapter under `adapters/` is the distribution and contribution model.
7. **Self-host first.** No SaaS, billing, or multi-tenant control plane. The runtime is optimized for an operator running their own adapter and gateway.

## Layer responsibilities

| Layer | Responsibility | Knows about | Does not know about |
| --- | --- | --- | --- |
| Adapter (`adapters/<name>/`) | Turn an external tool into deterministic MCP tools | target CLI/API, arguments, JSON, domain schema | remote transport, Cloudflare |
| Skill (`plugin/skills/`) | Tool call order, LLM judgment, coverage invariants | adapter tool surface, domain workflow | CLI implementation detail, transport |
| Registry (`registry/`) | Validate adapter manifests; own adapter identity, lifecycle (register/start/stop), and normalized health/status | the manifest contract, lifecycle state transitions | any adapter's tool names/schemas/results, transport wiring, domain reasoning |
| Runtime | Run an adapter as a stdio MCP server | MCP server contract | domain reasoning |
| Gateway (`gateway/`) | Turn stdio MCP into remote MCP | MCP protocol/transport | OCR or any other adapter's domain semantics |
| Deployment (`deployments/cloudflare/`) | Tunnel / Worker / Managed OAuth / secrets | network, auth, hosting | adapter tool semantics |

## Adapter manifest and runtime registry

`registry/` (`@majiwari/registry`) is the generic boundary that lets one resident runtime host more than one adapter. It is the core-vs-adapter ownership split this platform is built on:

- **Core (`registry/src/manifest.js`, `registry/src/registry.js`) owns**: the versioned manifest schema (`schemaVersion`, `id`, `version`, `transport`, optional `capabilities`), identity uniqueness within one runtime, lifecycle transitions (`registered` -> `starting` -> `running` -> `stopping` -> `stopped`, or `errored`), and a normalized health/status shape that looks the same for every adapter no matter its transport.
- **Adapter (each manifest) owns**: what its `id`/`version` mean, how its `transport` reaches it (`stdio` with a `start()`/`stop()` pair the registry calls opaquely, or a remote MCP `endpoint` URL with optional `connect()`/`disconnect()`), what its optional `health()` checks, what its optional `listTools()` discovers, and what its optional `capabilities` advertise. The registry never inspects a tool's name, schema, or result -- that surface stays owned by the adapter's own MCP server, per the transparency principle above.

A manifest fails validation deterministically (`AdapterManifestError`, one message per offending field) on a wrong `schemaVersion`, a malformed `id`/`version`, an unknown top-level field, an unsupported `transport.kind`, or a declared hook (`start`, `stop`, `health`, `listTools`, `connect`, `disconnect`) that is not a function. `AdapterRegistry#register` additionally rejects a second manifest reusing an already-registered `id` (`DuplicateAdapterError`).

Adapter failures are isolated by construction: `start()`/`stop()` catch a rejecting transport hook and record it on that adapter's own entry as `errored` rather than throwing out of the call, so one broken adapter cannot block or crash the registration/lifecycle of any other registered adapter. Only a lookup against an unregistered `id` throws (`UnknownAdapterError`), since that is a caller bug, not an adapter failure.

This lands the contract from #22 first; migrating the OCR adapter onto it and building the operator UI are separate, later issues (see Non-goals below and #22).

## Multi-adapter gateway routing

`gateway/src/registry-gateway.js` (`createRegistryGateway`) is the runtime that hosts more than one adapter through `registry/` behind one public gateway. Majiwari is the single ingress: Cloudflare/public infrastructure routes everything to this one gateway process (see Runtime below), never directly to an individual adapter. `publish(manifest)` registers and starts an adapter; `unpublish(id)` stops routing new requests to it, closes every session currently routed to it, and releases its one upstream resource -- all without touching any other adapter's sessions or resource.

Each adapter is exposed at its own path-based MCP endpoint, `/mcp/:adapterId` -- a single deterministic lookup of the registered adapter id parsed from the request path, resolved through the registry, never a branch on adapter type, transport kind, or capabilities. Each adapter keeps exactly one upstream `mcpClient`/process, acquired once through the registry's own `start()`/`stop()`. How the gateway reaches that resource internally -- one loopback-only `mcp-proxy` HTTP bridge per adapter, with a thin path-routing reverse proxy on the single public port dispatching to it -- is an internal implementation detail; a downstream session only ever gets a fresh per-session `Server` bridged onto that adapter's own `mcpClient` via [mcp-proxy](https://github.com/punkpeye/mcp-proxy)'s `proxyServer`, so tool discovery/invocation always reaches the selected adapter's own native names, schemas, and results, and one adapter's failure, crash, or removal cannot reach another's sessions.

A resource returned by an adapter's `transport.start()`/`connect()` is gateway-routable only if it satisfies the explicit contract `gateway/src/gateway-transport.js` defines and validates: a connected `mcpClient` (an `@modelcontextprotocol/client` `Client`) plus the `serverVersion`/`serverCapabilities` it negotiated. This is a generic gateway concern, not something `registry/` inspects or validates -- the registry stays opaque to handle shape (see above) -- and any transport kind, present or future (`gateway/src/stdio-target.js`'s "stdio" convention, or a later "endpoint" transport for a remote MCP server), satisfies it the same way, so an adapter migrating onto `registry/` -- OCR (`adapters/open-code-review/src/manifest.js`), or a future Inari adapter -- can implement it without any OCR/Inari-specific code living in `gateway/` or `registry/`. A startup failure that partially acquired a resource (a spawned process, a partially negotiated connection) releases what it acquired before rejecting, and a failed `publish()` always leaves the adapter id's registry entry cleared (`AdapterRegistry#unregister`) so the same id can be retried safely.

This is additive to, and does not replace, the single-target CLI (`gateway/bin/gateway.mjs`), which OCR's deployment still uses in production. OCR's own manifest (`adapters/open-code-review/src/manifest.js`) now satisfies this gateway-routable contract and can be published through `createRegistryGateway` at `/mcp/open-code-review`; actually switching OCR's production deployment over from `gateway/bin/gateway.mjs` to the registry gateway is a separate, later change (see Non-goals below).

## Runtime

```text
ChatGPT
  |
  | MCP over Streamable HTTP + Cloudflare Access Managed OAuth
  v
Cloudflare Worker  (public /mcp entry point; Access-protected; origin hidden)
  |
  | Cloudflare Named Tunnel (outbound-only from the local machine)
  v
gateway/  (generic stdio MCP -> Streamable HTTP; no adapter-specific logic)
  |
  | spawns as a child process, stdio
  v
adapters/open-code-review/  (deterministic MCP tools wrapping the ocr CLI)
  |-- ocr delegate preview --format json
  |-- ocr delegate rule --format json
  `-- bounded, read-only git diff/show/grep and file reads
          |
          v
      target Git checkout
```

The gateway is [mcp-proxy](https://github.com/punkpeye/mcp-proxy) (see `gateway/bin/gateway.mjs`, a thin CLI wrapper), which bridges the spawned stdio MCP server to Streamable HTTP at the transport level rather than parsing and re-emitting tool calls through a high-level MCP `Server`/`Client`. This is what makes "the gateway never changes a tool name, schema, or result" a structural property of the code, not just a convention to remember. This repository does not hand-roll transport bridging: an earlier hand-rolled bridge crashed the whole gateway process on an unhandled rejection whenever a client's connection closed before the stdio child's response arrived.

## Security boundary

- The adapter exposes no arbitrary shell, write, edit, commit, push, or fix tool. Child processes are invoked with fixed executables, argument arrays, and `shell: false`.
- Repository reads reject absolute/traversal paths and resolve symlinks before reading. Git refs reject option-like values and newline/NUL injection.
- One adapter process is bound to one Git repository (`--repo` or `OCR_REPO`).
- The gateway binds to localhost only; only the Tunnel is outbound from the development machine.
- The Worker sits behind a Cloudflare Access Managed OAuth boundary on `/mcp` and never exposes the gateway's Tunnel hostname to a client (see `deployments/cloudflare/worker/src/index.ts`).
- No secret (Tunnel credentials, Access service-token credentials) is committed to this repository. OAuth state itself is owned entirely by Cloudflare Access, not this repository.

## Supported delegation targets

- workspace
- branch/range (`--from` + `--to`)
- single commit

Repo-wide `ocr scan` is intentionally absent because upstream OCR does not currently expose it through Delegation Mode.

## OpenCodeReview's place in this platform

OCR is the first adapter, not a special case baked into the gateway or deployment layers. Concretely:

- `adapters/open-code-review/` wraps `ocr delegate preview`/`ocr delegate rule` (upstream, confirmed against `alibaba/open-code-review` source) plus bounded read-only Git access -- deterministic engineering only.
- The review reasoning itself is delegated to the host LLM through [`plugin/skills/open-code-review-delegate/SKILL.md`](../plugin/skills/open-code-review-delegate/SKILL.md), which mirrors upstream's `skills/open-code-review-delegate/SKILL.md` execution contract.
- `gateway/` and `deployments/cloudflare/` contain zero OCR-specific branching. Any other stdio MCP server can be pointed at the same gateway.

Upstream `alibaba/open-code-review` is confirmed (by reading its source and docs directly, not by assumption) to be an MCP **client** -- it has no `mcp`/`serve` CLI subcommand and does not expose a server for other tools to connect to. There is no upstream OCR MCP server to bridge; the adapter in this repository is what makes OCR's delegation output available as MCP tools at all.

## Future direction (explicitly not in v0)

The following are documented here as the intended direction if a second adapter is ever built, but are **not implemented** in this repository yet. Do not treat their presence in this section as a claim that the code exists.

- **`toolkit/`** -- scaffolding (`adapter init`), a schema helper, a subprocess-safe invocation primitive, a structured JSON parser, a bounded file/context primitive, fixture harness, MCP conformance tests, and a security lint, so a new adapter does not reinvent `adapters/open-code-review/src/core.js`'s patterns from scratch.
- **`adapter-authoring` Skill** -- an LLM-facing workflow (capability discovery -> separate deterministic/LLM-judgment work -> tool surface design -> schema/fixture generation -> scaffold -> contract test -> PR) for building a new adapter.
- ~~Migrating the OCR adapter onto `registry/`'s manifest/registry contract~~ -- done: `adapters/open-code-review/src/manifest.js` builds the adapter's manifest, using `@majiwari/gateway`'s own `createStdioGatewayTransport` (`gateway/src/stdio-target.js`) as its transport rather than a hand-rolled spawn, so its `start()` resolves the explicit gateway-routable handle (`gateway/src/gateway-transport.js`) and the adapter can be published through `createRegistryGateway` at `/mcp/open-code-review` with no OCR-specific code in `gateway/` or `registry/`. `src/runtime.js` (`npm run start:registry`) registers and starts it through `AdapterRegistry` directly, for standalone registry hosting without the gateway. `src/server.js` (`npm start`) is unchanged and keeps working standalone; both are a second way to host the same server, not a replacement.
- **Community contribution CI gates** -- manifest/schema validation, deterministic fixture replay, MCP conformance, and security lint enforced automatically on `adapters/` pull requests.
- **A real second adapter using the multi-adapter gateway in production.** The runtime that hosts more than one adapter through the registry now exists (see "Multi-adapter gateway routing" above), and OCR itself is now gateway-routable (see above); a genuinely new second adapter actually running alongside it in production is still a separate, later change.

This mirrors the original project boundary: broadening scope before a real second use case creates duplication is deferred until that duplication is real.
