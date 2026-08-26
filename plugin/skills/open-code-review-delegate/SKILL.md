---
name: open-code-review-delegate
description: Run OpenCodeReview delegation mode with ChatGPT as the host review model. OCR is authoritative for review scope and rule resolution; use the read-only OCR adapter tools for repository context.
license: Apache-2.0
metadata:
  upstream: https://github.com/alibaba/open-code-review
  upstream-skill: skills/open-code-review-delegate/SKILL.md
  adapter-version: 0.1.0
---

# Open Code Review — ChatGPT Delegation Adapter

Use this workflow for OCR delegated code review. Do not invent a separate review pipeline. OCR owns deterministic file selection and rule matching; the host model performs the review reasoning.

## Preconditions

1. Call `adapter_health` before the first review in a session.
2. If delegation JSON support is unavailable, stop and report the OCR compatibility problem. Do not fall back to `ocr review`.
3. Never request OCR LLM credentials. Delegation mode is LLM-free on the OCR side.
4. All tools exposed by this adapter are read-only. Do not mutate the repository as part of this skill.
5. If the adapter is managed (multi-target), obtain `targetId` before the first workspace-sensitive call and pass the exact same `targetId` on every `ocr_delegate_preview`, `ocr_delegate_rules`, `scan_delegate_preview`, `ocr_rules_check`, `repo_diff`, `repo_read_file`, and `repo_search` call for this workflow. Never infer, remember, or reuse a `targetId` from an earlier session or workflow -- treat it the same as any other required call argument. Standalone/single-repository adapters omit `targetId` entirely.

## Workflow

### 1. Determine review scope with OCR

Call `ocr_delegate_preview` exactly once for the requested target:

- workspace: no target fields
- branch/range: `from` and `to`
- commit: `commit`

Pass user-provided business context as `background` when relevant.

Treat the returned OCR preview as authoritative. Use every `reviewable_files` entry to create an explicit internal checklist. The checklist identity is `(path, status)`, not only `path`.

### 2. Resolve review rules with OCR

Call `ocr_delegate_rules` for the paths selected by OCR. For large changes, rule calls may be batched, but every reviewable entry must be covered by its OCR-resolved rules.

Do not replace OCR rule matching with host-generated rules.

### 3. Read each selected change

For every checklist entry, call `repo_diff` using the mode/ref metadata returned by OCR preview.

- range: pass OCR's `merge_base` and `to`
- commit: pass OCR's `commit`
- workspace tracked entry: `workspace_source="tracked"`
- workspace untracked entry: `workspace_source="untracked"`

Use `repo_read_file` and `repo_search` only when additional repository context is needed to evaluate a selected change.

### 4. Perform the delegated review

Review every OCR-selected entry against its OCR-resolved rule group. The host model may reason over diffs and read-only context, but it must not alter OCR's scope or silently omit entries.

Report only findings that survive scrutiny. Use OCR's finding shape:

- `path` (required)
- `content` (required)
- `start_line` (optional)
- `end_line` (optional)
- `category` (optional): `bug`, `security`, `performance`, `maintainability`, `test`, `style`, `documentation`, `other`
- `severity` (optional): `critical`, `high`, `medium`, `low`

### 5. Coverage is mandatory

Account for every `(path, status)` entry as reviewed or skipped with a concrete reason. Final output must include:

- findings
- total file-entry count
- reviewed count
- skipped count
- coverage rate

A successful review requires full accounting, not merely a list of findings.

## Prohibited fallbacks

- Do not call `ocr review`.
- Do not call `ocr llm test`.
- Do not ask for `OCR_LLM_*` variables or provider credentials.
- Do not substitute generic ChatGPT repository review for OCR delegation.
- Do not introduce write/edit/fix operations into this skill.

## Upstream fidelity

This adapter intentionally mirrors Alibaba OpenCodeReview's `open-code-review-delegate` execution contract while substituting read-only MCP tools for local shell access. When upstream adds a structured aggregate delegation task command, prefer adapting this skill to that contract rather than maintaining parallel orchestration here.
