# ChatGPT plugin assets

`skills/open-code-review-delegate/SKILL.md` is the ChatGPT-facing workflow definition for OCR Delegation Mode.

The `adapters/open-code-review` MCP server also carries a concise copy of the same execution contract in its server instructions, so the Cloudflare-connected path (see [`docs/CHATGPT_SETUP.md`](../docs/CHATGPT_SETUP.md)) is usable even before a separate Skill is installed/published.

This directory deliberately does not contain a Codex plugin manifest: this repository targets ChatGPT. Keep the Skill aligned with Alibaba OpenCodeReview's upstream `skills/open-code-review-delegate/SKILL.md` and do not fork review behavior.
