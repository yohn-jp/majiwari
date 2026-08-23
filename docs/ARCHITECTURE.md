# Architecture

## Principle

This project is a **host adapter**, not a code-review engine.

Alibaba OpenCodeReview (OCR) remains authoritative for deterministic review engineering:

- file selection and exclusions
- workspace/range/commit metadata
- rule resolution
- delegation schema

ChatGPT supplies only the host-model reasoning that OCR Delegation Mode explicitly delegates.

## Runtime

```text
ChatGPT
  |
  | custom MCP app (Tunnel connection)
  v
OpenAI Secure MCP Tunnel
  |
  | outbound-only tunnel-client
  v
local stdio MCP adapter
  |-- ocr delegate preview --format json
  |-- ocr delegate rule --format json
  |-- read-only git diff/show/grep
  `-- bounded repository file reads
          |
          v
      target Git checkout
```

The target repository never needs to be exposed on a public HTTP endpoint. `tunnel-client` can launch this adapter directly as a local stdio MCP command.

## Security boundary

The adapter intentionally exposes no arbitrary shell, write, edit, commit, push, or fix tool. Child processes are invoked with fixed executables, argument arrays, and `shell: false`.

Repository reads reject absolute/traversal paths and resolve symlinks before reading. Git refs reject option-like values and newline/NUL injection.

One adapter process is bound to one Git repository (`--repo` or `OCR_REPO`). Run a separate adapter/tunnel runtime for a different checkout when strict repository isolation is desired.

## Supported delegation targets

- workspace
- branch/range (`--from` + `--to`)
- single commit

Repo-wide `ocr scan` is intentionally absent because upstream OCR does not currently expose it through Delegation Mode. Adding an independent scan/review path here would violate the project's boundary.
