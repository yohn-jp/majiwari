# OpenCodeReview for ChatGPT

Use **Alibaba OpenCodeReview Delegation Mode** with ChatGPT as the host review model.

> This project does not implement code review. OCR remains authoritative for deterministic file selection and rule resolution; ChatGPT performs only the review reasoning that OCR Delegation Mode delegates.

## Architecture

```text
ChatGPT
  -> OpenAI Secure MCP Tunnel
  -> local read-only stdio MCP adapter
  -> OCR Delegation Mode + read-only Git context
  -> target repository
```

No public MCP hosting is required. OpenAI's Secure MCP Tunnel can launch the local stdio adapter directly and keep the repository/MCP server off the public internet.

## Supported targets

- current workspace changes
- branch/range review
- single commit review

`ocr scan` / repository-wide scan is intentionally not exposed until OCR supports that path through Delegation Mode upstream.

## Requirements

- Node.js 20+
- Git 2.41+
- Alibaba OpenCodeReview (`ocr`)
- OpenAI `tunnel-client` and Secure MCP Tunnel access for ChatGPT connectivity

Install OCR:

```bash
npm install -g @alibaba-group/open-code-review
ocr --version
ocr delegate preview --help
```

Delegation Mode does **not** require OCR LLM credentials.

## Install

```bash
git clone https://github.com/yohn-jp/open-code-review-chatgpt.git
cd open-code-review-chatgpt
npm install
npm test
npm run check
```

## Run locally

Bind one adapter process to one target Git checkout:

```bash
npm start -- --repo /absolute/path/to/target-repository
```

Equivalent environment-variable form:

```bash
OCR_REPO=/absolute/path/to/target-repository npm start
```

The server speaks MCP over stdio.

## Connect to ChatGPT with Secure MCP Tunnel

The shortest path is to let the official tunnel client launch the stdio adapter itself:

```bash
export CONTROL_PLANE_API_KEY="<runtime-api-key>"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile ocr-chatgpt \
  --tunnel-id "<tunnel-id>" \
  --mcp-command "node /absolute/path/to/open-code-review-chatgpt/adapter/src/server.js --repo /absolute/path/to/target-repository"

tunnel-client doctor --profile ocr-chatgpt --explain
tunnel-client run --profile ocr-chatgpt
```

Then create a ChatGPT custom MCP app in Developer Mode with **Connection: Tunnel** and select/enter that tunnel ID.

See [`docs/SECURE_MCP_TUNNEL.md`](docs/SECURE_MCP_TUNNEL.md) for the complete setup.

## MCP tools

| Tool | Responsibility |
| --- | --- |
| `adapter_health` | verify Git/OCR/delegation JSON support |
| `ocr_delegate_preview` | let OCR choose the exact review scope |
| `ocr_delegate_rules` | let OCR resolve review rules |
| `repo_diff` | read a selected workspace/range/commit diff |
| `repo_read_file` | read bounded repository context |
| `repo_search` | fixed-string read-only Git search |

There is deliberately no `review`, `fix`, `edit`, arbitrary `shell`, commit, or push tool.

## Review contract

For every delegated review, ChatGPT must:

1. verify `adapter_health`;
2. call OCR preview exactly once for the requested target;
3. resolve OCR rules for every `reviewable_files` entry;
4. review every selected `(path, status)` entry using its diff and only necessary context;
5. report findings plus total/reviewed/skipped counts and coverage rate.

The same contract is included in the MCP server instructions and in [`plugin/skills/open-code-review-delegate/SKILL.md`](plugin/skills/open-code-review-delegate/SKILL.md).

## Security

- fixed `ocr` / `git` executables only
- argument arrays with `shell: false`
- read-only MCP tools only
- no repository mutation
- path traversal / absolute path / symlink escape protection
- unsafe Git refs and newline/NUL injection rejected
- one configured repository per adapter process

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Upstream

OpenCodeReview: https://github.com/alibaba/open-code-review

The upstream project and Delegation Skill are Apache-2.0 licensed. This project preserves attribution and is intended to converge upstream rather than fork OCR's review behavior.
