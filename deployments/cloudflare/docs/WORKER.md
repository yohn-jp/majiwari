# Cloudflare Worker

The Worker is the only public entry point. It terminates OAuth and proxies `/mcp` to the gateway's Tunnel origin. It never exposes the gateway's hostname to a client.

## Prerequisites

- [`TUNNEL.md`](TUNNEL.md) completed: a Named Tunnel hostname protected by Cloudflare Access
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
- `oauthKvNamespaceId`: ID printed by the KV creation command
- `originAccess.clientId`: Cloudflare Access service-token client ID for the Worker-to-gateway origin boundary (see [`TUNNEL.md`](TUNNEL.md))
- `operatorAccess.teamDomain`: Cloudflare Access team domain, for example `https://<team-name>.cloudflareaccess.com`
- `operatorAccess.audience`: Cloudflare Access application audience tag for the path-scoped `/authorize` application
- `operatorAccess.operatorEmail`: email address allowed to approve the single-operator grant

The profile is the single source of truth for these deployment values. Do not copy them into `wrangler.jsonc` or `src/index.ts`. `wrangler.jsonc` also binds `CONSENT_STATE` to `ConsentStateDurableObject` and includes its initial migration. The Durable Object stores each consent request separately and atomically consumes it; do not remove that binding or migration -- the profile-generation step preserves both from the base config unchanged.

Create the OAuth KV namespace and put its ID in the profile:

```bash
cd deployments/cloudflare/worker
npx wrangler kv namespace create OAUTH_KV
cd ../../..
```

## 2. Run preflight

Run this before every deployment, including deployments from a fresh checkout:

```bash
npm --workspace @majiwari/worker run preflight -- \
  --profile deployments/cloudflare/deployment-profile.local.json
```

Preflight rejects missing values, placeholders, malformed URLs, non-`/mcp` paths, a public URL equal to the Tunnel origin, invalid Cloudflare IDs, and missing required secret bindings. Diagnostics print configuration status and binding names only; secret values are never read or printed.

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

## 4. Configure Cloudflare Access for the operator

Create a Cloudflare Access self-hosted application for the Worker's public hostname with path `/authorize*`. Add one `Allow` policy for the operator's email address and no policy for any other identity. The Access application audience tag is not a secret, but it must match the profile's `operatorAccess.audience`.

The `operatorAccess.teamDomain`, `operatorAccess.audience`, and `operatorAccess.operatorEmail` profile values are generated into `wrangler.jsonc`'s `vars` as `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, and `OPERATOR_EMAIL`. They are not secrets in the `wrangler secret put` sense -- Cloudflare Access authenticates the operator and the Worker only validates its assertion against them.

The Worker validates `Cf-Access-Jwt-Assertion` against the Access certificate endpoint, issuer, audience, expiry, and configured email. A missing, invalid, or disallowed assertion receives no consent state and cannot reach `completeAuthorization()`. Keep the Access application path-scoped so OAuth token and discovery endpoints remain owned by the OAuth Provider.

## 5. Deploy

```bash
npm --workspace @majiwari/worker run deploy -- \
  --profile deployments/cloudflare/deployment-profile.local.json
```

The deploy wrapper validates the profile, generates an ignored temporary Wrangler config, and invokes `wrangler deploy`. The public MCP URL is injected through Wrangler's build-time `define`, because `OAuthProvider` is constructed at module load before request-time `env` exists. Repeating this command from a clean checkout uses the same profile and requires no source edits.

## 6. Verify

```bash
curl -s https://<worker-hostname>/health
# {"ok":true}

curl -s -o /dev/null -w '%{http_code}\n' https://<worker-hostname>/mcp
# 401 -- unauthenticated /mcp is rejected

curl -s https://<worker-hostname>/.well-known/oauth-protected-resource/mcp | jq .
curl -s https://<worker-hostname>/.well-known/oauth-authorization-server | jq .
```

Protected-resource metadata must report the exact profile `publicMcpUrl`, including `/mcp`. Authorization-server metadata must use the same public Worker origin for its issuer and OAuth endpoints. See [`OAUTH.md`](OAUTH.md) for the discovery flow.

An unauthenticated request to `/mcp` must return `401` with a `WWW-Authenticate: Bearer ...` challenge pointing at `/.well-known/oauth-protected-resource/mcp`.

## Operator authentication and consent

An authenticated Access request to `GET /authorize` validates the OAuth request and known client, then displays the client ID, client name, and requested scopes. The operator must submit an explicit `Approve` action. `POST /authorize` requires the one-use consent state, a CSRF token in both the form and an HttpOnly cookie, and the same Access subject that opened the page. Durable Object storage transactionally consumes the state, so concurrent submissions can produce at most one grant. `Deny` redirects with `access_denied` and creates no grant.

The OAuth Provider remains responsible for request validation, PKCE, authorization codes, access and refresh tokens, refresh-token rotation, DCR/CIMD, and bearer validation. This Worker only owns Access identity verification and consent.

## Secrets and configuration

- `GATEWAY_ACCESS_CLIENT_ID` and `GATEWAY_ACCESS_CLIENT_SECRET` are Wrangler secrets provisioned in step 3, authenticating the Worker to the Tunnel-protected gateway origin (the origin protection boundary). They are not present in the profile, repository files, or Worker responses.
- `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, and `OPERATOR_EMAIL` (step 4, from the profile's `operatorAccess`) belong to a separate boundary: they are not secrets in the `wrangler secret put` sense -- Cloudflare Access authenticates the operator and the Worker only validates its assertion against them. Never collapse this boundary with the origin protection boundary above; they protect different hops and use independent Access applications.
- `OAUTH_KV` holds provider-managed state (registered clients, grants, and tokens) as a binding, not a secret value. `CONSENT_STATE` holds short-lived consent state in Durable Object storage, which atomically consumes it so concurrent submissions can produce at most one grant.
- Tunnel credentials stay on the local machine and never enter the profile.
- `GATEWAY_ORIGIN` and the KV namespace ID are non-secret deployment configuration, supplied through the local profile. Review them before publishing a fork; neither replaces the Worker Access secrets. Never commit a filled-in `deployment-profile.local.json` or generated Wrangler config from a shared/production account into a public fork without checking your organization's disclosure policy for resource IDs; an ID alone does not grant access without account credentials.
- If a future auth provider is added, store its client secret with `npx wrangler secret put <NAME>` and list the binding name in the profile's `secretBindings`.
