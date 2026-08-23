# Cloudflare Named Tunnel

Exposes the local `gateway/` process to Cloudflare without opening an inbound port on the development machine. The Tunnel is outbound-only.

## Prerequisites

- a Cloudflare account with a zone (domain) you control
- `cloudflared` installed locally
- Terraform 1.5 or newer
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

## 4. Provision the Access boundary

Run [`deployments/cloudflare/terraform`](../terraform/README.md) with the exact hostname from step 3. It creates:

- a self-hosted Cloudflare Access application for the Tunnel hostname
- a dedicated Service Token for this Worker
- a `non_identity` Service Auth policy whose only include rule is that Service Token

The Terraform API token needs `Access: Apps and Policies Write` and `Access: Service Tokens Write`. Keep Terraform state encrypted or remote because it contains the generated Service Token secret.

Set the two Worker secrets from Terraform output. The commands pipe values directly to Wrangler; do not print, log, or commit them:

```bash
cd deployments/cloudflare/worker
terraform -chdir=../terraform output -raw worker_access_client_id | npx wrangler secret put GATEWAY_ACCESS_CLIENT_ID
terraform -chdir=../terraform output -raw worker_access_client_secret | npx wrangler secret put GATEWAY_ACCESS_CLIENT_SECRET
```

## 5. Configure ingress

Copy [`tunnel/config.example.yml`](../tunnel/config.example.yml) to `~/.cloudflared/config.yml` (do not commit this file), then replace its placeholders with the Tunnel UUID, hostname, Access team name, and Terraform output `access_application_audience_tag`:

```yaml
tunnel: <UUID from step 2>
credentials-file: /home/you/.cloudflared/<UUID>.json

ingress:
  - hostname: majiwari-gateway.internal.example.com
    service: http://127.0.0.1:8787
    originRequest:
      access:
        required: true
        teamName: <Cloudflare Access team name>
        audTag:
          - <Access application audience tag>
  - service: http_status:404
```

The `access` block must remain under this hostname's ingress rule. `cloudflared` uses it to validate the `Cf-Access-Jwt-Assertion` header for the protected route before proxying to the gateway. The port must match the gateway's `--port` (see `gateway/src/server.js`).

Validate the ingress configuration before starting the tunnel:

```bash
cloudflared tunnel ingress validate --config ~/.cloudflared/config.yml
```

## 6. Run the tunnel

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml run majiwari-gateway
```

Keep this running alongside the gateway process. Both are local-machine, outbound-only processes; neither opens an inbound firewall port.

## 7. Verify

From a network outside the local machine, verify that an unauthenticated client cannot reach the gateway directly:

```bash
curl -i -X POST https://majiwari-gateway.internal.example.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-06-18","capabilities":{},"clientInfo":{"name":"curl-check","version":"0.0.0"}}}'
```

Expect HTTP `401` or `403`; the request must not reach the local gateway. A request with only the Worker's configured Service Token is the authorized origin path, and the Worker supplies that token server-side. End-user traffic must go through the Worker's Managed-OAuth-protected `/mcp`, not this hostname directly (see [`OAUTH.md`](OAUTH.md)). Verify that path with the same MCP request and a Cloudflare Access-issued token:

```bash
curl -i -X POST https://<worker-hostname>/mcp \
  -H "authorization: Bearer ${MCP_ACCESS_TOKEN}" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-06-18","capabilities":{},"clientInfo":{"name":"curl-check","version":"0.0.0"}}}'
```

A successful MCP response confirms the Worker's Managed OAuth boundary, Service Token injection, and Tunnel Access validation are all connected.

## Secrets

- Tunnel credentials JSON: stays on the local machine (`~/.cloudflared/`), never committed, never handed to the Worker.
- Access Service Token credentials: stored only as Wrangler secrets on the Worker and in protected Terraform state; never stored in repository files or logs.
