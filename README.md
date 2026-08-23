# Majiwari

Deterministic CLI/API-to-MCP adapters, plus a generic gateway that exposes any stdio MCP server remotely over Cloudflare. **Alibaba OpenCodeReview (OCR) delegation is the first adapter**, not the platform's purpose.

> Adapters know what a tool means. The gateway knows only what MCP transport means. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository layout

```text
adapters/open-code-review/   deterministic MCP tools wrapping the ocr CLI (stdio)
gateway/                     generic stdio MCP -> Streamable HTTP transport, no adapter-specific logic
deployments/cloudflare/      Named Tunnel + Worker (/mcp proxy, Access Managed OAuth) + their setup docs
plugin/skills/                ChatGPT-facing Delegation Mode skill
docs/                         architecture and ChatGPT connection docs
```

## Architecture

```text
ChatGPT
  -> Cloudflare Worker (/mcp, Access Managed OAuth-protected, origin hidden)
  -> Cloudflare Named Tunnel (outbound-only from the local machine)
  -> gateway/ (generic stdio MCP -> Streamable HTTP)
  -> adapters/open-code-review/ (deterministic MCP tools)
  -> ocr CLI + read-only Git context
  -> target repository
```

This project does not implement code review. OCR remains authoritative for deterministic file selection and rule resolution; the host LLM (ChatGPT) performs only the review reasoning that OCR Delegation Mode delegates.

## Requirements

- Node.js 20+
- Git 2.41+
- Alibaba OpenCodeReview (`ocr`)
- a Cloudflare account, for the Tunnel/Worker/Access Managed OAuth deployment (see [`deployments/cloudflare/docs/`](deployments/cloudflare/docs/))

Install OCR:

```bash
npm install -g @alibaba-group/open-code-review
ocr --version
ocr delegate preview --help
```

Delegation Mode does **not** require OCR LLM credentials.

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
npm run gateway -- --port 8787 -- node adapters/open-code-review/src/server.js --repo /absolute/path/to/target-repository
```

The gateway binds to `127.0.0.1` only and never inspects the tools it proxies -- any other stdio MCP server can be given to it the same way.

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

## Review contract

For every delegated review, the host LLM must:

1. verify `adapter_health`;
2. call OCR preview exactly once for the requested target;
3. resolve OCR rules for every `reviewable_files` entry;
4. review every selected `(path, status)` entry using its diff and only necessary context;
5. report findings plus total/reviewed/skipped counts and coverage rate.

The same contract is included in the MCP server instructions and in [`plugin/skills/open-code-review-delegate/SKILL.md`](plugin/skills/open-code-review-delegate/SKILL.md).

## Security

- fixed `ocr` / `git` executables only, `shell: false`, argument arrays
- read-only MCP tools only, no repository mutation
- path traversal / absolute path / symlink escape protection
- unsafe Git refs and newline/NUL injection rejected
- one configured repository per adapter process
- gateway binds to `127.0.0.1` only; only the Tunnel is outbound
- Worker sits behind Cloudflare Access Managed OAuth on `/mcp` and never exposes the Tunnel hostname to a client
- no secret committed to this repository

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Upstream

OpenCodeReview: https://github.com/alibaba/open-code-review

The upstream project and Delegation Skill are Apache-2.0 licensed. This project preserves attribution and is intended to converge upstream rather than fork OCR's review behavior.
