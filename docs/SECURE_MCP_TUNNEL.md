# Secure MCP Tunnel

OpenAI Secure MCP Tunnel connects a private or localhost MCP server to ChatGPT without exposing the MCP server to the public internet. The official `tunnel-client` supports launching a local **stdio** MCP command directly, which matches this adapter.

## Prerequisites

- an OpenAI organization/workspace with Secure MCP Tunnel access
- a tunnel ID
- a runtime API key with Tunnels Read + Use
- `tunnel-client`
- this repository installed (`npm install`)
- OCR installed globally
- a local Git checkout to review

Start with the official client guidance:

```bash
tunnel-client help quickstart
```

## Create a local stdio profile

From any directory, point `--mcp-command` at this checkout and the target repository:

```bash
export CONTROL_PLANE_API_KEY="<runtime-api-key>"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile ocr-chatgpt \
  --tunnel-id "<tunnel-id>" \
  --mcp-command "node /absolute/path/to/open-code-review-chatgpt/adapter/src/server.js --repo /absolute/path/to/target-repo"
```

Validate and start it:

```bash
tunnel-client doctor --profile ocr-chatgpt --explain
tunnel-client run --profile ocr-chatgpt
```

Keep `tunnel-client run` healthy while ChatGPT discovers or invokes the app.

## ChatGPT

In ChatGPT Developer Mode, create a custom MCP app using **Connection: Tunnel**, then select or enter the tunnel ID. Do not enter a localhost/private MCP URL.

After connection, verify `adapter_health` first. A delegated review should then use OCR preview/rules and the read-only repository context tools exposed by the adapter.

## Operational model

The tunnel is outbound-only from the machine that can access the repository. No inbound firewall rule or public Cloudflare/Cloud Run deployment is required for this development/self-hosted model.

For persistent use, run `tunnel-client` under your normal process supervisor (systemd, launchd, container/Kubernetes, etc.) and protect the runtime API key as a secret.
