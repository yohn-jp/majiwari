# Cloudflare Worker

The Worker is the only public entry point. `/mcp` sits behind Cloudflare Access Managed OAuth and proxies to the gateway's Tunnel origin. It never exposes the gateway's hostname to a client.

## Prerequisites

- [`TUNNEL.md`](TUNNEL.md) completed: a Named Tunnel hostname protected by Cloudflare Access
- the `/mcp` Managed OAuth Access Application provisioned via [`../terraform/access.tf`](../terraform/access.tf) (`terraform apply` with `public_mcp_hostname` set; see [`../terraform/README.md`](../terraform/README.md))
- a Cloudflare account, `wrangler` authenticated (`npx wrangler login`)
- Node.js 20+

## 1. Create a local deployment profile

Copy the tracked template. The local file is ignored by Git:

```bash
cp deployments/cloudflare/deployment-profile.example.json \
  deployments/cloudflare/deployment-profile.local.json
```

Fill these non-secret values in `deployment-profile.local.json`:

- `accountId`: Cloudflare account ID
- `publicMcpUrl`: public Worker MCP endpoint, with the exact `/mcp` path
- `gatewayOrigin`: Tunnel origin, also with the exact `/mcp` path
- `mcpAccess.teamDomain`: Cloudflare Access team domain, for example `https://<team-name>.cloudflareaccess.com`
- `mcpAccess.audience`: the `/mcp` Access Application's audience tag (`terraform output -raw mcp_access_audience_tag` in [`../terraform/`](../terraform/))

The profile is the single source of truth for these deployment values. Do not copy them into `wrangler.jsonc` or `src/index.ts`.

## 2. Run preflight

Run this before every deployment, including deployments from a fresh checkout:

```bash
npm --workspace @majiwari/worker run preflight -- \
  --profile deployments/cloudflare/deployment-profile.local.json
```

Preflight rejects missing values, placeholders, malformed URLs, non-`/mcp` paths, a public URL equal to the Tunnel origin, and missing required secret bindings. Diagnostics print configuration status and binding names only; secret values are never read or printed.

## 3. Provision secret bindings

Service credentials belong in Wrangler secrets, not in the profile or any tracked/generated configuration. The profile requires the `GATEWAY_ACCESS_CLIENT_ID` and `GATEWAY_ACCESS_CLIENT_SECRET` bindings, authenticating the Worker to the Tunnel-protected gateway origin. Their values come from the Terraform outputs described in [`TUNNEL.md`](TUNNEL.md). Generate the profile-specific Wrangler config, then provision the values interactively:

```bash
npm --workspace @majiwari/worker run deploy -- \
  --profile deployments/cloudflare/deployment-profile.local.json \
  --dry-run

cd deployments/cloudflare/worker
npx wrangler secret put GATEWAY_ACCESS_CLIENT_ID \
  --config wrangler.profile.generated.jsonc
npx wrangler secret put GATEWAY_ACCESS_CLIENT_SECRET \
  --config wrangler.profile.generated.jsonc
cd ../../..
```

`wrangler.profile.generated.jsonc` contains only profile values and secret binding names. It is ignored by Git. `wrangler secret put` sends each secret to Cloudflare; no secret value is written to the repository. `GATEWAY_ACCESS_CLIENT_SECRET` is accepted only by the upstream request and is never exposed to the MCP client.

## 4. Deploy

```bash
npm --workspace @majiwari/worker run deploy -- \
  --profile deployments/cloudflare/deployment-profile.local.json
```

The deploy wrapper validates the profile, generates an ignored temporary Wrangler config, and invokes `wrangler deploy`. Repeating this command from a clean checkout uses the same profile and requires no source edits.

## 5. Verify

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

- `GATEWAY_ACCESS_CLIENT_ID` and `GATEWAY_ACCESS_CLIENT_SECRET` are Wrangler secrets provisioned in step 3, authenticating the Worker to the Tunnel-protected gateway origin (the origin protection boundary). They are not present in the profile, repository files, or Worker responses.
- `MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUDIENCE` (from the profile's `mcpAccess`) belong to a separate boundary: they are not secrets in the `wrangler secret put` sense -- Cloudflare Access authenticates the caller and the Worker only validates its assertion against them. Never collapse this boundary with the origin protection boundary above; they protect different hops and use independent Access Applications.
- Tunnel credentials stay on the local machine and never enter the profile.
- `GATEWAY_ORIGIN` is non-secret deployment configuration, supplied through the local profile. Review it before publishing a fork; it does not replace the Worker Access secrets. Never commit a filled-in `deployment-profile.local.json` or generated Wrangler config from a shared/production account into a public fork without checking your organization's disclosure policy for resource IDs; an audience tag alone does not grant access without account credentials.
- If a future auth provider is added, store its client secret with `npx wrangler secret put <NAME>` and list the binding name in the profile's `secretBindings`.
