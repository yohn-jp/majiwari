# Plan

## Goal

Make ChatGPT a host model for Alibaba OpenCodeReview Delegation Mode without adding any independent review engine or review heuristics.

## Boundary

OCR remains authoritative for:

- reviewable file selection
- exclusions
- range/commit/workspace metadata
- rule resolution
- delegation schema

The adapter provides only read-only transport from ChatGPT to:

- `ocr delegate preview --format json`
- `ocr delegate rule --format json`
- bounded Git diff/file/search operations required by the upstream delegation workflow

ChatGPT provides only the host-model reasoning that the upstream Delegation Skill already delegates.

## v0 tools

| Tool | Purpose | State |
| --- | --- | --- |
| `adapter_health` | Verify Git/OCR/repo/delegation JSON capability | read-only |
| `ocr_delegate_preview` | Ask OCR which entries to review | read-only |
| `ocr_delegate_rules` | Ask OCR which rules apply | read-only |
| `repo_diff` | Obtain the exact selected diff/full new file | read-only |
| `repo_read_file` | Read bounded context | read-only |
| `repo_search` | Fixed-string Git search for context | read-only |

There is deliberately no `review`, `fix`, `edit`, `shell`, or arbitrary command tool.

## Delivery phases

1. **Local adapter** — stdio MCP adapter + tests + fail-closed OCR schema handling.
2. **Secure Tunnel E2E** — connect a local checkout to ChatGPT using `tunnel-client`'s stdio profile and verify workspace/range/commit modes.
3. **Compatibility hardening** — add golden fixtures from real OCR preview/rule JSON and version-compatibility coverage.
4. **Plugin packaging** — publish/install the Delegation Skill together with the MCP app once the ChatGPT plugin packaging surface is stable for this use case.
5. **Upstream path** — propose a ChatGPT integration upstream rather than forking review logic.

## Current limitation

The upstream Delegation Skill covers workspace, branch/range, and single-commit review. Full-repository `ocr scan` is a separate OCR execution path and is intentionally not exposed here. Do not fake repo-wide delegated scan.
