# Majiwari

Deterministic CLI/API-to-MCP adapters, plus a generic gateway that exposes any stdio MCP server remotely over Cloudflare. **Alibaba OpenCodeReview (OCR) delegation is the first adapter**, not the platform's purpose. `adapters/inari/` wraps [Inari](https://github.com/yohn-jp/gh-inari) (`gh-inari`), a governed GitHub CLI for repository Issue/PR templates, as the second.

> Adapters know what a tool means. The gateway knows only what MCP transport means. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository layout

```text
adapters/open-code-review/   deterministic MCP tools wrapping the ocr CLI (stdio)
adapters/inari/               deterministic MCP tools wrapping the inari CLI (stdio)
gateway/                     generic stdio MCP -> Streamable HTTP transport, no adapter-specific logic
registry/                     versioned adapter manifest schema and runtime registry
runtime/                      resident local runtime, trusted catalog, and loopback ingress
deployments/cloudflare/      Named Tunnel + Worker (/mcp proxy, Access Managed OAuth) + their setup docs
plugin/skills/                ChatGPT-facing Delegation Mode skill
docs/                         architecture and ChatGPT connection docs
```

## Architecture

```text
ChatGPT
  -> Cloudflare Worker (/mcp, Access Managed OAuth-protected, origin hidden)
  -> Workers VPC Service binding (bypasses the public zone's DNS and WAF)
  -> Cloudflare Named Tunnel (outbound-only from the local machine)
  -> gateway/ (generic stdio MCP -> Streamable HTTP)
  -> adapters/open-code-review/ (deterministic MCP tools)
  -> ocr CLI + read-only Git context
  -> target repository
```

This project does not implement code review. OCR remains authoritative for deterministic file selection and rule resolution; the host LLM (ChatGPT) performs only the review reasoning that OCR Delegation Mode delegates.

## Requirements

- Node.js >=24
- Git 2.41+
- Alibaba OpenCodeReview (`ocr`), for the OCR adapter
- Inari (`gh-inari`) and an authenticated `gh`, for the Inari adapter
- a Cloudflare account, for the Tunnel/Worker/Access Managed OAuth deployment (see [`deployments/cloudflare/docs/`](deployments/cloudflare/docs/))

Install OCR:

```bash
npm install -g @alibaba-group/open-code-review
ocr --version
ocr delegate preview --help
```

Delegation Mode does **not** require OCR LLM credentials.

Install Inari:

```bash
npm install -g gh-inari
gh auth login
inari --version --json
```

The Inari adapter uses the current `gh` authentication and the target repository's Git remote; it does not maintain a second credential store. `adapters/inari/src/core.js` checks Inari's machine-readable identity/protocol/capability contract (not a version pin -- any `gh-inari` release that still reports the expected identity, protocol version, and required capabilities is compatible) and fails `adapter_health` clearly, rather than silently, if the installed `inari` does not satisfy it. `.github/workflows/ci.yml`'s `inari-contract` job installs whatever `gh-inari` currently resolves (latest) and verifies the same contract.

## Install

```bash
git clone https://github.com/yohn-jp/majiwari.git
cd majiwari
npm install
npm test
npm run check
npm run doctor -- --repo /absolute/path/to/target-repository
```

## Run locally

Start the OCR adapter directly (stdio MCP) against one target Git checkout:

```bash
npm start -- --repo /absolute/path/to/target-repository
```

Equivalent environment-variable form: `OCR_REPO=/absolute/path/to/target-repository npm start`.

To make it reachable over HTTP, put the generic gateway in front of it:

```bash
npm run gateway -- --port 8787 -- node /absolute/path/to/majiwari/adapters/open-code-review/src/server.js --repo /absolute/path/to/target-repository
```

`npm run gateway` runs the script inside the `gateway` workspace, so its working directory is `gateway/`, not the repo root -- use an absolute path for the target server script, or the gateway will spawn a nonexistent file and every request will hang with an empty response.

The gateway binds to `127.0.0.1` only and never inspects the tools it proxies -- any other stdio MCP server can be given to it the same way.

Start the Inari adapter directly (stdio MCP) against one target Git checkout:

```bash
npm run inari -- --repo /absolute/path/to/target-repository
```

Equivalent environment-variable form: `INARI_REPO=/absolute/path/to/target-repository npm run inari`. Check its own prerequisites with `npm run inari:doctor -- --repo /absolute/path/to/target-repository`.

Inari also registers through `registry/`'s `AdapterRegistry` and satisfies `gateway/`'s gateway-routable transport contract (`adapters/inari/src/manifest.js`, using `@majiwari/gateway`'s own `createStdioGatewayTransport`, the same convention OCR's manifest uses) -- so it can be hosted standalone through the registry (`npm run inari:registry`) or published on a `createRegistryGateway` instance at `/mcp/inari`, the same way OCR is published at `/mcp/open-code-review`. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the manifest/registry/gateway contract.

### Resident local golden path

The resident runtime is the composed local process for running both trusted adapters on one loopback ingress. It owns config, the desired adapter set, registry lifecycle, signals, and the shared HTTP listener; `gateway/` only attaches MCP bridges and `ui/` only projects the same registry. It never accepts arbitrary commands, modules, URLs, or environment maps.

Create a local config outside the repository (repository paths are private operator configuration):

```json
{
  "version": 1,
  "port": 8787,
  "adapters": {
    "open-code-review": {
      "enabled": true,
      "repo": "/absolute/path/to/target-repository"
    },
    "inari": {
      "enabled": true,
      "repo": "/absolute/path/to/target-repository"
    }
  }
}
```

Start it with:

```bash
npm run resident -- --config /absolute/path/to/majiwari.runtime.json
```

The listener is always `127.0.0.1`; the one shared port serves:

- `http://127.0.0.1:8787/mcp/open-code-review`
- `http://127.0.0.1:8787/mcp/inari`
- `http://127.0.0.1:8787/ui`
- `http://127.0.0.1:8787/ui/api/adapters` and `/ui/api/adapters/:id`

For a local smoke:

```bash
curl -fsS http://127.0.0.1:8787/ui >/dev/null
curl -fsS http://127.0.0.1:8787/ui/api/adapters
```

Then connect an MCP Inspector or SDK client independently to both `/mcp/...` endpoints, list and call an adapter-owned tool on each, and send `SIGINT` or `SIGTERM` to confirm the process exits. Runtime/UI/MCP status does not print configured absolute repository paths.

The legacy standalone commands remain supported and are intentionally separate: `npm start` and `npm run inari` start one stdio adapter, `npm run gateway` wraps one arbitrary stdio MCP command, and `npm run ui` serves an empty standalone UI. Use `npm run resident` for the shared local composition.

## Connect to ChatGPT

See [`docs/CHATGPT_SETUP.md`](docs/CHATGPT_SETUP.md) for the full path: exposing the gateway through a Cloudflare Named Tunnel ([`deployments/cloudflare/docs/TUNNEL.md`](deployments/cloudflare/docs/TUNNEL.md)), deploying the Worker in front of it ([`deployments/cloudflare/docs/WORKER.md`](deployments/cloudflare/docs/WORKER.md)), and confirming Access Managed OAuth ([`deployments/cloudflare/docs/OAUTH.md`](deployments/cloudflare/docs/OAUTH.md)) before registering the connector in ChatGPT.

## MCP tools (`adapters/open-code-review`)

| Tool | Responsibility |
| --- | --- |
| `adapter_health` | verify Git/OCR/delegation JSON support |
| `ocr_delegate_preview` | let OCR choose the exact review scope |
| `ocr_delegate_rules` | let OCR resolve review rules |
| `repo_diff` | read a selected workspace/range/commit diff |
| `repo_read_file` | read bounded repository context |
| `repo_search` | fixed-string read-only Git search |

There is deliberately no `review`, `fix`, `edit`, arbitrary `shell`, commit, or push tool. The gateway and Worker layers do not add one either -- they carry these tool names/schemas through unmodified.

## MCP tools (`adapters/inari`)

| Tool | Responsibility |
| --- | --- |
| `adapter_health` | verify Inari's identity/protocol/capability compatibility and GitHub authentication |
| `inari_template_list` | discover repository-governed Issue/PR templates |
| `inari_issue_schema` / `inari_pr_schema` | resolve a template's canonical field schema |
| `inari_issue_get` / `inari_pr_get` | read an existing Issue/PR's canonical fields |
| `inari_issue_validate` / `inari_pr_validate` | validate new field content, or classify an existing Issue/PR by number |
| `inari_issue_create` / `inari_pr_create` | validate, render, and create a governed Issue/PR |

Inari remains authoritative for template governance, semantic validation, and rendering; the adapter only translates arguments and normalizes results. There is no raw `gh` passthrough tool, and no `edit`/`normalize`/`sync` remediation tool in this initial surface.

## Review contract

For every delegated review, the host LLM must:

1. verify `adapter_health`;
2. call OCR preview exactly once for the requested target;
3. resolve OCR rules for every `reviewable_files` entry;
4. review every selected `(path, status)` entry using its diff and only necessary context;
5. report findings plus total/reviewed/skipped counts and coverage rate.

The same contract is included in the MCP server instructions and in [`plugin/skills/open-code-review-delegate/SKILL.md`](plugin/skills/open-code-review-delegate/SKILL.md).

## Security

- fixed `ocr` / `inari` / `gh` / `git` executables only, `shell: false`, argument arrays
- OCR's MCP tools are read-only; Inari's `*_create` tools are the only tools in this repository that mutate GitHub, and only after Inari's own validation and rendering succeed
- path traversal / absolute path / symlink escape protection
- unsafe Git refs and newline/NUL injection rejected
- one configured repository per adapter process
- gateway binds to `127.0.0.1` only; only the Tunnel is outbound
- Worker sits behind Cloudflare Access Managed OAuth on `/mcp` and reaches the gateway over a Workers VPC Service binding, never a public hostname
- no secret committed to this repository

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Upstream

OpenCodeReview: https://github.com/alibaba/open-code-review

The upstream project and Delegation Skill are Apache-2.0 licensed. This project preserves attribution and is intended to converge upstream rather than fork OCR's review behavior.

Inari (`gh-inari`): https://github.com/yohn-jp/gh-inari, MIT licensed. This project preserves attribution and does not reimplement any Inari governance rule; the adapter only translates MCP calls to Inari's own CLI.
