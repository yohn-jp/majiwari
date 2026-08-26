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
| UI shell (`ui/`) | Project the registry's list/detail/health/tools into an operator-facing web view | the registry projection surface | any adapter's domain semantics, MCP tool behavior |
| Runtime | Own desired adapters and invoke registry lifecycle; compose the resident process | adapter manifests, lifecycle policy, ingress composition | MCP session publication details |
| Ingress | Own the public listening socket and dispatch bounded route namespaces | HTTP request routing | adapter lifecycle, MCP protocol semantics |
| Gateway (`gateway/`) | Publish already-running resources through MCP session bridges | MCP protocol/transport, registry resource lookup | adapter lifecycle, OCR or any other adapter's domain semantics |
| Deployment (`deployments/cloudflare/`) | Tunnel / Worker / Managed OAuth / secrets | network, auth, hosting | adapter tool semantics |

## Adapter manifest and runtime registry

`registry/` (`@majiwari/registry`) is the generic boundary that lets one resident runtime host more than one adapter. It is the core-vs-adapter ownership split this platform is built on:

- **Core (`registry/src/manifest.js`, `registry/src/registry.js`) owns**: the versioned manifest schema (`schemaVersion`, `id`, `version`, `transport`, optional `capabilities`), identity uniqueness within one runtime, lifecycle transitions (`registered` -> `starting` -> `running` -> `stopping` -> `stopped`, or `errored`), and a normalized health/status shape that looks the same for every adapter no matter its transport.
- **Adapter (each manifest) owns**: what its `id`/`version` mean, how its `transport` reaches it (`stdio` with a `start()`/`stop()` pair the registry calls opaquely, or a remote MCP `endpoint` URL with optional `connect()`/`disconnect()`), what its optional `health()` checks, what its optional `listTools()` discovers, and what its optional `capabilities` advertise. The registry never inspects a tool's name, schema, or result -- that surface stays owned by the adapter's own MCP server, per the transparency principle above.

A manifest fails validation deterministically (`AdapterManifestError`, one message per offending field) on a wrong `schemaVersion`, a malformed `id`/`version`, an unknown top-level field, an unsupported `transport.kind`, or a declared hook (`start`, `stop`, `health`, `listTools`, `connect`, `disconnect`) that is not a function. `AdapterRegistry#register` additionally rejects a second manifest reusing an already-registered `id` (`DuplicateAdapterError`).

Adapter failures are isolated by construction: `start()`/`stop()` catch a rejecting transport hook and record it on that adapter's own entry as `errored` rather than throwing out of the call, so one broken adapter cannot block or crash the registration/lifecycle of any other registered adapter. Only a lookup against an unregistered `id` throws (`UnknownAdapterError`), since that is a caller bug, not an adapter failure.

This lands the contract from #22 first; migrating the OCR adapter onto it and wiring a runtime that actually hosts it plus a second adapter are separate, later issues (see Non-goals below and #22).

## Operator web UI shell

`ui/` (`@majiwari/ui`) is a generic, registry-driven operator UI: `createUiHandler(registry, { basePath: "/ui" })` projects one `AdapterRegistry`'s `list()`/`get()`/`tools()`/`health()`, and optional `listTargets()`, into `/ui/api/adapters` and `/ui/api/adapters/:id`, while serving `/ui` and `/ui/*` static assets. It owns no adapter identity of its own and receives only generic registry/public projections; resolved target descriptors and local paths never cross this boundary. An unknown adapter id maps to `404`, and malformed/path-shaped ids fail closed without URI-decoding exceptions. Tool discovery, health, and target projection failures are isolated to their own bounded sections, so errored/stopped entries remain visible even when they have no gateway publication. `mountUi()` embeds this handler in an externally owned ingress; `createUiServer()` and `ui/bin/ui.mjs` remain the standalone root-mounted CLI path.

## Multi-adapter gateway routing

`gateway/src/registry-gateway.js` (`createRegistryGateway`) owns only MCP publication/session bridges. The resident runtime registers and starts manifests through `AdapterRegistry`, then calls `attach(adapterId)` only for entries that are already `RUNNING` and have a gateway-routable resource. `detach(adapterId)` removes new routing and closes that adapter's downstream sessions/bridge but never calls `registry.stop()` or unregisters it. `publish(manifest)`/`unpublish(id)` remain compatibility wrappers for the standalone/test API and are the only path where the gateway temporarily owns lifecycle for a manifest it registered itself.

Each adapter is exposed at its own path-based MCP endpoint, `/mcp/:adapterId` -- a single deterministic lookup of the registered adapter id parsed from the request path, resolved through the registry, never a branch on adapter type, transport kind, or capabilities. The gateway exposes `handle()`/`mount()` for an externally owned Node HTTP ingress; it never closes that listener during disposal. The same ingress dispatches `/mcp/:adapterId` and `/ui/*`, while unrelated paths fail closed. Each adapter keeps exactly one upstream `mcpClient`/process, acquired by the runtime through the registry's lifecycle. Internally, one loopback-only `mcp-proxy` HTTP bridge per attached adapter and a thin path-routing reverse proxy preserve byte-for-byte MCP request/response streaming; tool names, schemas, results, and session traffic remain native to the selected adapter.

A resource returned by an adapter's `transport.start()`/`connect()` is gateway-routable only if it satisfies the explicit contract `gateway/src/gateway-transport.js` defines and validates: a connected `mcpClient` plus the negotiated `serverVersion`/`serverCapabilities`. This is a gateway concern, not something `registry/` inspects. Attach rejects unknown, errored/stopped/non-running, or malformed-resource entries deterministically without acquiring a bridge; a failed registry start remains in registry state for UI observation. Any transport kind can satisfy the same contract, so OCR and Inari remain generic consumers with no adapter-specific branch in gateway/registry.

This is additive to, and does not replace, the single-target CLI (`gateway/bin/gateway.mjs`), which OCR's deployment still uses in production. OCR's own manifest (`adapters/open-code-review/src/manifest.js`) now satisfies this gateway-routable contract and can be published through `createRegistryGateway` at `/mcp/open-code-review`; actually switching OCR's production deployment over from `gateway/bin/gateway.mjs` to the registry gateway is a separate, later change (see Non-goals below).

## Shared ingress ownership

The externally composed resident process has one `http.Server`: ingress creates, listens, and closes it. Its bounded dispatcher sends `/mcp/:adapterId` to the gateway handler and `/ui`/`/ui/*` to the UI handler, then returns `404` for every unrelated or malformed route. Gateway `attach()`/`detach()` owns only MCP publication and downstream sessions; UI owns only registry projection and static rendering. Disposing either mount removes its handler and closes only its own internal bridge/session state, never the shared listener or another adapter's registry resource. The standalone gateway and UI CLIs retain their existing listener ownership as compatibility entry points.

`runtime/` (`@majiwari/runtime`) is the resident implementation of that composition. Its version-1 JSON config is validated before it creates a registry, listener, adapter manifest, or child process. The built-in catalog is closed to `open-code-review` and `inari`; an enabled entry must provide its own absolute `repo`, so resident operation never derives repository selection from the process cwd. Startup binds the fixed loopback listener, registers every configured manifest, starts each through `AdapterRegistry`, and calls `gateway.attach(id)` only for entries that are `RUNNING`. A start failure remains in the registry as `errored`; an attach failure leaves the `RUNNING` registry entry and resource observable. Shutdown is one shared idempotent path: stop accepting ingress, close gateway bridges, finish the shared listener, then stop registered adapter resources.

## Optional target-provider capability (#26)

A manifest may declare an optional, separately versioned `targetProvider` (`registry/src/target-provider.js`, `TARGET_PROVIDER_SCHEMA_VERSION`): four hooks, `list`/`get`/`resolve`/`invalidate`, for an adapter that operates against selectable, adapter-defined targets (e.g. a workspace or checkout) rather than a single fixed one. It is entirely opt-in -- an adapter that never sets `targetProvider` is validated and behaves exactly as before, and calling `AdapterRegistry#listTargets`/`getTarget`/`resolveTarget`/`invalidateTarget` against it throws `TargetCapabilityUnsupportedError`. OCR implements this capability as of #29 (see its section below); Inari does not yet and remains a single-target adapter bound to one Git repository, unaffected by this contract's existence.

The registry enforces these boundary properties generically, without knowing what any adapter's targets mean:

- Every client-supplied target id is validated as an opaque identifier (`parseTargetId`) before it ever reaches a provider hook, so a path-shaped id (e.g. `../../etc/passwd`) can never bypass target resolution to reach an adapter's own filesystem or process handling.
- Every value returned by `list()`/`get()` is validated against the public target schema, which structurally has no field for the adapter-internal `descriptor` `resolve()` returns -- only `resolve()` can produce one, and it never crosses back out through `list()`/`get()`. What a resolved descriptor actually contains (a filesystem path, a URL, anything else) is entirely adapter-defined and never reaches a remote client.
- Public target metadata (`publicTargetSchema`'s `metadata` field) is restricted to JSON-safe values (strings, numbers, booleans, `null`, and arrays/plain objects of those) by schema, not by convention -- a provider cannot pass a function, `BigInt`, `Symbol`, or other non-serializable value through the public projection.

This lands the contract from #26 (tracking #22) first; a Mottainai-specific target-discovery provider and Mottainai-specific workspace-switching UI are separate, later, adapter-specific work -- this repository's `registry/` stays generic and never encodes what a target means for any one adapter. The generic operator UI shell (`ui/`, above) projects whatever `listTargets()` returns for an adapter that declares the capability, without ever branching on what a target means for that adapter.

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
- **Target-aware managed execution (#29).** `createManifest({ targetProvider })` (`adapters/open-code-review/src/manifest.js`) switches OCR from its default single-repository stdio child to a managed, target-aware mode: one resident MCP server, built by the shared tool-handler factory `adapters/open-code-review/src/build-server.js` and bridged in-process (no OS process, no wire protocol -- `@modelcontextprotocol/sdk`'s `InMemoryTransport`) via `adapters/open-code-review/src/managed-transport.js`. `ocr_delegate_preview`, `ocr_delegate_rules`, `scan_delegate_preview`, `ocr_rules_check`, `repo_diff`, `repo_read_file`, and `repo_search` all accept an optional `targetId`; in managed mode it is required and resolved -- via the exact target-provider object passed to `createManifest`, the same authority `AdapterRegistry#listTargets`/`getTarget`/`resolveTarget`/`invalidateTarget` use -- immediately before that one call's OCR/git/filesystem access, never cached as a current/selected target. `adapters/open-code-review/src/local-target-provider.js` is the static, in-memory "fixture/local provider" this issue proves the contract with; dynamic discovery (Mottainai sessions, #30) is a separate, later provider behind the same contract. Standalone mode (`repo`, no `targetProvider`) is unchanged: `server.js` still spawns as a single-repository stdio child and ignores any `targetId` it is given.

Upstream `alibaba/open-code-review` is confirmed (by reading its source and docs directly, not by assumption) to be an MCP **client** -- it has no `mcp`/`serve` CLI subcommand and does not expose a server for other tools to connect to. There is no upstream OCR MCP server to bridge; the adapter in this repository is what makes OCR's delegation output available as MCP tools at all.

## Inari's place in this platform

Inari (`gh-inari`, upstream `yohn-jp/gh-inari`) is a governed GitHub CLI that turns a repository's native Issue Forms and pull request templates into deterministic typed contracts, validating and rendering GitHub Issues/PRs before any mutation. `adapters/inari/` is the second adapter, and, like OCR, registers through `registry/`'s manifest contract and is gateway-routable:

- `adapters/inari/src/core.js` builds `inari <domain> <command> --json [...]` argument arrays deterministically (template discovery/schema, issue/PR get, issue/PR validate, issue/PR create) and parses Inari's own structured JSON stdout. Inari's exit codes `0`/`1`/`2`/`3`/`4` (success/usage/validation/remote/internal) are all JSON on stdout for these governed commands, so the adapter relays Inari's `ok`/`valid`/`error` fields to the MCP caller rather than collapsing a governed validation failure into a thrown exception.
- Inari remains the sole authority for template governance, semantic validation, and rendering; the adapter never encodes a governance rule of its own. No raw `gh` passthrough is exposed -- only the bounded, explicit tool set in `adapters/inari/src/server.js`.
- `adapters/inari/src/core.js` treats Inari's machine-readable *protocol/capability* contract (`inari --version --json`'s `name`, `protocol`, and `capabilities`) as the compatibility boundary, deliberately **not** a semantic-version pin: `EXPECTED_INARI_NAME` and `EXPECTED_INARI_PROTOCOL` are checked for an exact match, and `REQUIRED_INARI_CAPABILITIES` must all be present in the installed CLI's advertised `capabilities`. `inari_version` is reported for information only and never gates compatibility. `checkAdapterHealth()` -- shared by the `adapter_health` tool, `doctor.js`, and the manifest's own `health()` -- fails deterministically, with a `detail` naming exactly what is incompatible (identity, protocol, or a specific missing capability), if the installed `inari` does not satisfy this contract. A newer (or older) `gh-inari` release that still reports the expected identity/protocol and still advertises the required capabilities works with zero Majiwari change. `.github/workflows/ci.yml`'s `inari-contract` job installs whatever `gh-inari` currently resolves (latest, not pinned) and verifies the exact same protocol/capability contract the adapter's own runtime check validates.
- `adapters/inari/src/server.js`'s `adapter_health` tool and the manifest's `health()` (used by the generic registry health/status contract) both strip `repo_root` -- an absolute host filesystem path -- from their public output; only `doctor.js`'s local-only report keeps it, since that is a local diagnostic tool, not a remote MCP surface.
- `adapters/inari/src/manifest.js` builds the adapter's `registry/`-shaped manifest (`schemaVersion`, `id: "inari"`, `capabilities`) the same way OCR's does: `transport` is `@majiwari/gateway`'s own `createStdioGatewayTransport` (`gateway/src/stdio-target.js`), so `start()` resolves the explicit gateway-routable handle (`gateway/src/gateway-transport.js`), and the adapter can be published through `createRegistryGateway` at `/mcp/inari` with no Inari-specific code in `gateway/` or `registry/`. `src/runtime.js` (`npm run inari:registry`) registers and starts it through `AdapterRegistry` directly, for standalone registry hosting without the gateway; `src/server.js` (`npm run inari`) is unchanged and keeps working standalone. `adapters/inari/test/gateway-integration.test.js` proves this end to end against the real adapter (register -> start -> publish at `/mcp/inari` -> live tool discovery -> a real read-only tool call -> stop with no leaked process), including that no raw shell or unrestricted `gh` passthrough tool is published or callable, and that a sibling adapter published on the same gateway is unaffected when Inari is stopped.
- Like OCR, one adapter process is bound to one Git repository (`--repo` or `INARI_REPO`); Inari itself resolves the GitHub repository from that checkout's Git remote via the current `gh` authentication, the same way the real `gh` CLI does.

## Future direction (explicitly not in v0)

The following are documented here as the intended direction, but are **not implemented** in this repository yet. Do not treat their presence in this section as a claim that the code exists.

- **`toolkit/`** -- scaffolding (`adapter init`), a schema helper, a subprocess-safe invocation primitive, a structured JSON parser, a bounded file/context primitive, fixture harness, MCP conformance tests, and a security lint, so a new adapter does not reinvent `adapters/open-code-review/src/core.js`'s (or `adapters/inari/src/core.js`'s) patterns from scratch.
- **`adapter-authoring` Skill** -- an LLM-facing workflow (capability discovery -> separate deterministic/LLM-judgment work -> tool surface design -> schema/fixture generation -> scaffold -> contract test -> PR) for building a new adapter.
- ~~Migrating the OCR adapter onto `registry/`'s manifest/registry contract~~ -- done: `adapters/open-code-review/src/manifest.js` builds the adapter's manifest, using `@majiwari/gateway`'s own `createStdioGatewayTransport` (`gateway/src/stdio-target.js`) as its transport rather than a hand-rolled spawn, so its `start()` resolves the explicit gateway-routable handle (`gateway/src/gateway-transport.js`) and the adapter can be published through `createRegistryGateway` at `/mcp/open-code-review` with no OCR-specific code in `gateway/` or `registry/`. `src/runtime.js` (`npm run start:registry`) registers and starts it through `AdapterRegistry` directly, for standalone registry hosting without the gateway. `src/server.js` (`npm start`) is unchanged and keeps working standalone; both are a second way to host the same server, not a replacement.
- **Community contribution CI gates** -- manifest/schema validation, deterministic fixture replay, MCP conformance, and security lint enforced automatically on `adapters/` pull requests.
- **A real second adapter actually running alongside OCR through the multi-adapter gateway in production.** Inari (documented above) is now a real, tested second adapter that satisfies the same gateway-routable contract as OCR -- proven in `adapters/inari/test/gateway-integration.test.js`, including publishing both on one `createRegistryGateway` instance and isolating a stopped/crashed adapter from its sibling -- but wiring Inari into the production Cloudflare deployment alongside OCR (Runtime section above) is still a separate, later change; this repository's production Runtime diagram remains OCR-only until that happens.
- ~~An adapter that actually implements the target-provider capability (#26).~~ -- done for OCR: see "Target-aware managed execution (#29)" above. Inari does not implement it and remains single-target. Mottainai-specific target discovery (#30), workspace switching, Portless, and any UI built on top of the target-provider capability are separate, later, adapter-specific work.

This mirrors the original project boundary: broadening scope before a real second use case creates duplication is deferred until that duplication is real.
