# Cloudflare Named Tunnel

Exposes the local `gateway/` process to Cloudflare without opening an inbound port on the development machine. The Tunnel is outbound-only.

## Prerequisites

- a Cloudflare account with a zone (domain) you control
- `cloudflared` installed locally
- the Majiwari gateway running locally (see [`gateway/README` usage](../../../gateway) or `npm run gateway -- --port 8787 -- node adapters/open-code-review/src/server.js --repo /absolute/path/to/target-repository`)

## 1. Authenticate

```bash
cloudflared tunnel login
```

Opens a browser to authorize `cloudflared` against your Cloudflare account and zone.

## 2. Create the named tunnel

```bash
cloudflared tunnel create majiwari-gateway
```

Prints the tunnel UUID and writes credentials to `~/.cloudflared/<UUID>.json`. **Never commit this credentials file.**

## 3. Route a hostname to the tunnel

```bash
cloudflared tunnel route dns majiwari-gateway majiwari-gateway.internal.example.com
```

Use an internal-looking hostname under a zone you control. This hostname is the Worker's private origin -- it is never given to ChatGPT or any other MCP client directly.

## 4. Configure ingress

Create `~/.cloudflared/config.yml` (do not commit this file; keep it outside the repository or in a git-ignored local path):

```yaml
tunnel: <UUID from step 2>
credentials-file: /home/you/.cloudflared/<UUID>.json

ingress:
  - hostname: majiwari-gateway.internal.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

The port must match the gateway's `--port` (see `gateway/src/server.js`).

## 5. Run the tunnel

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml run majiwari-gateway
```

Keep this running alongside the gateway process. Both are local-machine, outbound-only processes; neither opens an inbound firewall port.

## 6. Verify

From a network outside the local machine, confirm the hostname resolves and an MCP client can reach it directly (before adding the Worker/OAuth layer in front of it):

```bash
curl -s -X POST https://majiwari-gateway.internal.example.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-06-18","capabilities":{},"clientInfo":{"name":"curl-check","version":"0.0.0"}}}'
```

A JSON-RPC response confirms the Tunnel is correctly forwarding to the gateway. Once confirmed, move on to [`WORKER.md`](WORKER.md) -- production traffic should go through the Worker's OAuth-protected `/mcp`, not this hostname directly.

## Secrets

- Tunnel credentials JSON: stays on the local machine (`~/.cloudflared/`), never committed, never handed to the Worker.
- No token or secret related to the Tunnel is stored in this repository.
