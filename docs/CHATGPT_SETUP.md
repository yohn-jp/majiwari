# ChatGPT setup

ChatGPT connects to a public Cloudflare Worker URL, not to a local process directly. The full path is:

```text
ChatGPT -> Cloudflare Worker (/mcp, OAuth) -> Cloudflare Named Tunnel -> gateway/ -> adapters/open-code-review/ -> ocr CLI
```

Complete the earlier setup steps first, in order:

1. [`README.md`](../README.md) -- install, run the OCR adapter locally, run the gateway locally
2. [`deployments/cloudflare/docs/TUNNEL.md`](../deployments/cloudflare/docs/TUNNEL.md) -- expose the gateway via a Named Tunnel
3. [`deployments/cloudflare/docs/WORKER.md`](../deployments/cloudflare/docs/WORKER.md) -- deploy the Worker in front of the Tunnel
4. [`deployments/cloudflare/docs/OAUTH.md`](../deployments/cloudflare/docs/OAUTH.md) -- confirm OAuth is enforced

Only after step 4 succeeds (unauthenticated `/mcp` returns `401`, and `.well-known` discovery documents are served) should you register the Worker with ChatGPT.

## Register the connector

1. In ChatGPT (web), go to **Settings -> Apps -> Advanced settings** and enable **Developer mode**. Developer mode requires a Pro, Plus, Business, Enterprise, or Education account.
2. Choose **Add custom connector**.
3. Under **Connection**, enter the Worker's MCP URL, including the `/mcp` path: `https://<worker-hostname>/mcp`.
4. ChatGPT performs OAuth discovery against that URL (see [`OAUTH.md`](../deployments/cloudflare/docs/OAUTH.md#discovery-flow)) and prompts you to complete the `/authorize` flow.
5. Enable the connector for your conversation.

Do not register the Tunnel's internal hostname (`GATEWAY_ORIGIN`) directly with ChatGPT -- it is unauthenticated and is meant to stay behind the Worker.

## First validation

Run these cases in order, in a conversation with the connector enabled and the [`open-code-review-delegate`](../plugin/skills/open-code-review-delegate/SKILL.md) skill available:

1. `adapter_health`
2. workspace review with one tracked edit and one untracked file
3. `main` -> feature branch range review
4. single-commit review
5. malicious path/ref inputs, to confirm the adapter's fail-closed validation still holds through the gateway and Worker

A valid review completes without OCR LLM credentials and accounts for every OCR preview `(path, status)` entry (see the skill's coverage requirement).
