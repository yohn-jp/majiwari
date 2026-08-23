# Cloudflare Named Tunnel

Exposes the local `gateway/` process to Cloudflare without opening an inbound port on the development machine. The Tunnel is outbound-only.

The Worker reaches the gateway over this Tunnel via a **Workers VPC Service** binding, which routes through Cloudflare's internal connectivity-directory path -- never the public zone's DNS or WAF. This is the only gateway path managed by the current Terraform configuration.

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

## 3. Provision the Workers VPC Service

Run [`deployments/cloudflare/terraform`](../terraform/README.md) with the
Tunnel ID from step 2 (`gateway_tunnel_id`). It creates:

- a Workers VPC Service (`cloudflare_connectivity_directory_service.gateway`) pointed at `127.0.0.1:8787` over this Tunnel -- this is what the Worker actually binds to

The Terraform API token needs `Access: Apps Write`, `Access: Policies Write`,
and `Connectivity Directory Admin` (to create the VPC Service; see
[`../terraform/README.md`](../terraform/README.md) for how to list this
account's exact permission group names, and for `with-scoped-token.sh`, which
mints this as a short-lived token instead of a standing one). Keep Terraform
state encrypted or remote.

Copy the VPC Service's ID into the deployment profile:

```bash
terraform -chdir=deployments/cloudflare/terraform output -raw gateway_vpc_service_id
```

Set `gatewayVpcServiceId` to this value in `deployment-profile.local.json` (see [`WORKER.md`](WORKER.md)). There is no Worker secret to provision for this path -- the binding itself is scoped to this Worker at creation time.

## 4. Run the tunnel

The Workers VPC Service needs the Tunnel connector running to reach the
gateway:

```bash
cloudflared tunnel run majiwari-gateway
```

Keep this running alongside the gateway process. Both are local-machine, outbound-only processes; neither opens an inbound firewall port.

## 5. Verify

Verify the Worker's normal path end to end with the same MCP request and a Cloudflare Access-issued token, after deploying the Worker (see [`WORKER.md`](WORKER.md)):

```bash
curl -i -X POST https://<worker-hostname>/mcp \
  -H "authorization: Bearer ${MCP_ACCESS_TOKEN}" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-06-18","capabilities":{},"clientInfo":{"name":"curl-check","version":"0.0.0"}}}'
```

A successful MCP response confirms the Worker's Managed OAuth boundary and the Workers VPC Service path to the gateway are both connected.

## Rollback

The current configuration does not provision a public Tunnel hostname,
self-hosted Access Application, or Service Token. If the Workers VPC path
regresses, revert the Terraform commit that removed those resources, review
the resulting `terraform plan`, and run `terraform apply`. Then use
[`tunnel/config.example.yml`](../tunnel/config.example.yml) for the restored
public-hostname ingress, if needed. Remove the temporary rollback resources by
applying the current configuration once the VPC path is healthy.

## Secrets

- Tunnel credentials JSON: stays on the local machine (`~/.cloudflared/`), never committed, never handed to the Worker.
- The Workers VPC Service binding carries no credential of its own -- authorization comes from the binding being scoped to this Worker in Terraform, not from a token.
- If a rollback commit restores an Access Service Token, its credentials must stay only in protected Worker/Terraform secret storage; never store them in repository files or logs.
