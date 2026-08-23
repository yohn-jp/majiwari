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
| Runtime | Run an adapter as a stdio MCP server | MCP server contract | domain reasoning |
| Gateway (`gateway/`) | Turn stdio MCP into remote MCP | MCP protocol/transport | OCR or any other adapter's domain semantics |
| Deployment (`deployments/cloudflare/`) | Tunnel / Worker / Managed OAuth / secrets | network, auth, hosting | adapter tool semantics |

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

The gateway bridges two MCP `Transport` instances directly at the `send`/`onmessage` level (see `gateway/src/server.js`) rather than parsing and re-emitting tool calls through a high-level MCP `Server`/`Client`. This is what makes "the gateway never changes a tool name, schema, or result" a structural property of the code, not just a convention to remember.

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
- **A concrete `Adapter` interface** -- `manifest()` / `tools()` / `invoke()` / `health()` -- once a second adapter's actual needs are known. Fixing this shape before a second adapter exists risks designing for a hypothetical.
- **Community contribution CI gates** -- manifest/schema validation, deterministic fixture replay, MCP conformance, and security lint enforced automatically on `adapters/` pull requests.
- **A second adapter.** Generalizing the gateway is considered validated only once a non-OCR adapter actually uses it.

This mirrors the original project boundary: broadening scope before a real second use case creates duplication is deferred until that duplication is real.
