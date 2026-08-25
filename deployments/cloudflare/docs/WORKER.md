# Cloudflare Worker

The Worker is the only public entry point. `/mcp` sits behind Cloudflare Access Managed OAuth and proxies to the gateway over a Workers VPC Service binding. It never exposes the gateway's address to a client, and the proxy hop never touches the public zone's DNS or WAF -- see [`../terraform/README.md`](../terraform/README.md) for why this replaced the earlier Tunnel-hostname-plus-service-token design.

## Prerequisites

- [`TUNNEL.md`](TUNNEL.md) completed: a Named Tunnel running the gateway
- the `/mcp` Managed OAuth Access Application and the Workers VPC Service both provisioned via [`../terraform/access.tf`](../terraform/access.tf) (`terraform apply` with `public_mcp_hostname` and `gateway_tunnel_id` set; see [`../terraform/README.md`](../terraform/README.md))
- a Cloudflare account, `wrangler` authenticated (`npx wrangler login`)
- Node.js >=22.13

## 1. Create a local deployment profile

Copy the tracked template. The local file is ignored by Git:

```bash
cp deployments/cloudflare/deployment-profile.example.json \
  deployments/cloudflare/deployment-profile.local.json
```

Fill these non-secret values in `deployment-profile.local.json`:

- `accountId`: Cloudflare account ID
- `publicMcpUrl`: public Worker MCP endpoint, with the exact `/mcp` path
- `gatewayVpcServiceId`: the Workers VPC Service's ID (`terraform output -raw gateway_vpc_service_id` in [`../terraform/`](../terraform/))
- `mcpAccess.teamDomain`: Cloudflare Access team domain, for example `https://<team-name>.cloudflareaccess.com`
- `mcpAccess.audience`: the `/mcp` Access Application's audience tag (`terraform output -raw mcp_access_audience_tag` in [`../terraform/`](../terraform/))

The profile is the single source of truth for these deployment values. Do not copy them into `wrangler.jsonc` or `src/index.ts`.

## 2. Run preflight

Run this before every deployment, including deployments from a fresh checkout:

```bash
npm --workspace @majiwari/worker run preflight -- \
  --profile deployments/cloudflare/deployment-profile.local.json
```

Preflight rejects missing values, placeholders, malformed URLs, and a non-`/mcp` public path. Diagnostics print configuration status only; the profile carries no secret values, so none are ever read or printed.

## 3. Deploy

```bash
npm --workspace @majiwari/worker run deploy -- \
  --profile deployments/cloudflare/deployment-profile.local.json
```

The deploy wrapper validates the profile, generates an ignored temporary Wrangler config (with the `vpc_services` binding wired to `gatewayVpcServiceId`), and invokes `wrangler deploy`. Repeating this command from a clean checkout uses the same profile and requires no source edits. There is no Wrangler secret to provision for the gateway path -- the VPC Service binding is scoped to this Worker at creation time in Terraform, so there is no origin-side credential to put in Wrangler secrets or rotate.

## 4. Verify

The `mcp`-type Access Application's `domain` covers the whole public hostname, not just `/mcp` -- so `/health` is also behind the Managed OAuth boundary once deployed with a custom domain, even though the Worker's own code (`src/index.ts`) would answer `/health` without checking the Access assertion:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-hostname>/health
# 401 from Cloudflare Access, before the request reaches the Worker

curl -s -o /dev/null -w '%{http_code}\n' https://<worker-hostname>/mcp
# 401/403 from Cloudflare Access, or a redirect/challenge, before the request
# reaches the Worker
```

To confirm the Worker's own routing and its unauthenticated `/health` branch directly (bypassing the Access boundary), hit the `workers.dev` route instead if one is enabled, or invoke `fetch` against the Worker in a local `wrangler dev` session.

See [`OAUTH.md`](OAUTH.md) for the full Managed OAuth flow and how the Worker validates the resulting `Cf-Access-Jwt-Assertion`.

## Secrets and configuration

- `GATEWAY_VPC` is a Workers VPC Service binding, not a secret -- it is wired up from the profile's `gatewayVpcServiceId` at deploy time and carries no credential value. The binding itself is the authorization: only this Worker can call `env.GATEWAY_VPC.fetch()` against the VPC Service it was bound to.
- `MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUDIENCE` (from the profile's `mcpAccess`) belong to a separate boundary: they are not secrets in the `wrangler secret put` sense -- Cloudflare Access authenticates the caller and the Worker only validates its assertion against them.
- Tunnel credentials stay on the local machine and never enter the profile.
- `gatewayVpcServiceId` is non-secret deployment configuration, supplied through the local profile. Never commit a filled-in `deployment-profile.local.json` or generated Wrangler config from a shared/production account into a public fork without checking your organization's disclosure policy for resource IDs; a service ID or audience tag alone does not grant access without account credentials.
- If a future auth provider is added, store its client secret with `npx wrangler secret put <NAME>` and list its `required` binding name in `wrangler.jsonc`'s `secrets` field.
