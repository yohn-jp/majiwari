# Cloudflare Named Tunnel

Exposes the local `gateway/` process to Cloudflare without opening an inbound port on the development machine. The Tunnel is outbound-only.

The Worker reaches the gateway over this Tunnel via a **Workers VPC Service** binding (step 4 below), which routes through Cloudflare's internal connectivity-directory path -- never the public zone's DNS or WAF. Steps 3 and 5-7 below cover an optional public hostname for the Tunnel, kept only as a rollback path (see [`WORKER.md`](WORKER.md)); it is not required for the Worker's normal path to the gateway.

## Prerequisites

- a Cloudflare account with a zone (domain) you control
- `cloudflared` installed locally
- Terraform 1.5 or newer
- the Majiwari gateway running locally (see [`gateway/`](../../../gateway) or `npm run gateway -- --port 8787 -- node /absolute/path/to/majiwari/adapters/open-code-review/src/server.js --repo /absolute/path/to/target-repository` -- the target script path must be absolute, since `npm run gateway` runs from the `gateway/` workspace directory, not the repo root)

## 1. Authenticate

```bash
cloudflared tunnel login
```

Opens a browser to authorize `cloudflared` against your Cloudflare account and zone.

## 2. Create the named tunnel

```bash
cloudflared tunnel create majiwari-gateway
```

Prints the tunnel UUID and writes credentials to `~/.cloudflared/<UUID>.json`. **Never commit this credentials file.** Keep the UUID -- it is `gateway_tunnel_id` in the next step and in Terraform.

## 3. (Optional, rollback path only) Route a hostname to the tunnel

Only needed if you intend to keep the legacy public-hostname-plus-service-token path available as a fallback (see [`WORKER.md`](WORKER.md)). The Worker's normal path to the gateway (step 4) does not use this hostname.

```bash
cloudflared tunnel route dns majiwari-gateway majiwari-gateway.internal.example.com
```

Use an internal-looking hostname under a zone you control. This hostname is never given to ChatGPT or any other MCP client directly.

## 4. Provision the Workers VPC Service

Run [`deployments/cloudflare/terraform`](../terraform/README.md) with the Tunnel ID from step 2 (`gateway_tunnel_id`) and, if you completed step 3, the hostname from step 3 (`gateway_hostname`, required by the variable but only consumed by the legacy rollback resources). It creates:

- a Workers VPC Service (`cloudflare_connectivity_directory_service.gateway`) pointed at `127.0.0.1:8787` over this Tunnel -- this is what the Worker actually binds to
- (legacy, unused by the Worker) a self-hosted Cloudflare Access application for the Tunnel hostname, a dedicated Service Token, and a `non_identity` Service Auth policy

The Terraform API token needs `Access: Apps and Policies Write`, `Access: Service Tokens Write` (for the legacy resources), and `Cloudflare One Connector: cloudflared` — Edit (to create the VPC Service; see [`../terraform/README.md`](../terraform/README.md) for the exact permission picker naming). Keep Terraform state encrypted or remote.

Copy the VPC Service's ID into the deployment profile:

```bash
terraform -chdir=deployments/cloudflare/terraform output -raw gateway_vpc_service_id
```

Set `gatewayVpcServiceId` to this value in `deployment-profile.local.json` (see [`WORKER.md`](WORKER.md)). There is no Worker secret to provision for this path -- the binding itself is scoped to this Worker at creation time.

## 5. (Optional, rollback path only) Configure ingress for the public hostname

Skip this unless you completed step 3. Workers VPC routing does not use `cloudflared`'s ingress rules at all -- they only matter for exposing a service to the public internet, which the legacy rollback path does.

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

The `access` block must remain under this hostname's ingress rule. `cloudflared` uses it to validate the `Cf-Access-Jwt-Assertion` header for the protected route before proxying to the gateway. The port must match the gateway's `--port` (see `gateway/bin/gateway.mjs`).

Validate the ingress configuration before starting the tunnel. `--config` is a global flag and must come before the `tunnel` subcommand, not after it:

```bash
cloudflared --config ~/.cloudflared/config.yml tunnel ingress validate
```

## 6. Run the tunnel

`--config` is a global flag; keep it before the `tunnel` subcommand. This step is required regardless of whether you completed the optional public-hostname steps -- the Workers VPC Service (step 4) needs the Tunnel connector running to reach the gateway:

```bash
cloudflared --config ~/.cloudflared/config.yml tunnel run majiwari-gateway
```

If you skipped steps 3 and 5, run `cloudflared tunnel run majiwari-gateway` without `--config`; an ingress config is only required for the public-hostname rollback path.

Keep this running alongside the gateway process. Both are local-machine, outbound-only processes; neither opens an inbound firewall port.

## 7. Verify

Verify the Worker's normal path end to end with the same MCP request and a Cloudflare Access-issued token, after deploying the Worker (see [`WORKER.md`](WORKER.md)):

```bash
curl -i -X POST https://<worker-hostname>/mcp \
  -H "authorization: Bearer ${MCP_ACCESS_TOKEN}" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-06-18","capabilities":{},"clientInfo":{"name":"curl-check","version":"0.0.0"}}}'
```

A successful MCP response confirms the Worker's Managed OAuth boundary and the Workers VPC Service path to the gateway are both connected.

If you completed the optional rollback steps (3 and 5), also verify that an unauthenticated client cannot reach the gateway's public hostname directly:

```bash
curl -i -X POST https://majiwari-gateway.internal.example.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-06-18","capabilities":{},"clientInfo":{"name":"curl-check","version":"0.0.0"}}}'
```

Expect HTTP `401` or `403`; the request must not reach the local gateway.

## Secrets

- Tunnel credentials JSON: stays on the local machine (`~/.cloudflared/`), never committed, never handed to the Worker.
- The Workers VPC Service binding carries no credential of its own -- authorization comes from the binding being scoped to this Worker in Terraform, not from a token.
- (Legacy rollback path only) Access Service Token credentials: stored only as Wrangler secrets on the Worker and in protected Terraform state; never stored in repository files or logs.
