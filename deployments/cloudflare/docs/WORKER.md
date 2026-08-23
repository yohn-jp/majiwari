# Cloudflare Worker

The Worker is the only public entry point. It terminates OAuth and proxies `/mcp` to the gateway's Tunnel origin. It never exposes the gateway's hostname to a client.

## Prerequisites

- [`TUNNEL.md`](TUNNEL.md) completed: a Named Tunnel hostname protected by Cloudflare Access
- a Cloudflare account, `wrangler` authenticated (`npx wrangler login`)

## 1. Create the OAuth KV namespace

`@cloudflare/workers-oauth-provider` stores clients, grants, and tokens in a KV namespace:

```bash
cd deployments/cloudflare/worker
npx wrangler kv namespace create OAUTH_KV
```

Copy the printed `id` into `wrangler.jsonc`'s `kv_namespaces[0].id`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

`wrangler.jsonc` also binds `CONSENT_STATE` to `ConsentStateDurableObject` and includes its initial migration. The Durable Object stores each consent request separately and atomically consumes it; do not remove that binding or migration.

## 2. Point the Worker at the Tunnel origin

Edit `wrangler.jsonc`'s `vars.GATEWAY_ORIGIN` to the Tunnel hostname from `TUNNEL.md`, including the `/mcp` path:

```jsonc
"vars": {
  "GATEWAY_ORIGIN": "https://majiwari-gateway.internal.example.com/mcp"
}
```

This value is never sent to the client -- the Worker only ever proxies to it server-side.

## 3. Set Worker Access secrets

The Worker authenticates to the protected Tunnel with a dedicated Access Service Token. Set both values as Wrangler secrets; do not add them to `wrangler.jsonc`, source files, shell history, or logs:

```bash
npx wrangler secret put GATEWAY_ACCESS_CLIENT_ID
npx wrangler secret put GATEWAY_ACCESS_CLIENT_SECRET
```

The values come from the Terraform outputs described in [`TUNNEL.md`](TUNNEL.md). `GATEWAY_ACCESS_CLIENT_SECRET` is accepted only by the upstream request and is never exposed to the MCP client.

## 4. Set the public hostname in the OAuth resource metadata

Edit `src/index.ts`'s `resourceMetadata.resource` and `resourceMetadata.authorization_servers[0]` to this Worker's actual public hostname (the one you'll register in ChatGPT), e.g. `https://mcp.example.com`. This is compiled into the Worker at deploy time, not read from an environment variable -- `OAuthProvider`'s configuration is constructed at module load, before any request's `env` exists.

## 5. Configure Cloudflare Access for the operator

Create a Cloudflare Access self-hosted application for the Worker's public hostname with path `/authorize*`. Add one `Allow` policy for the operator's email address and no policy for any other identity. The Access application audience tag is not a secret, but it must match the Worker configuration.

Set these `vars` in `wrangler.jsonc`:

```jsonc
"ACCESS_TEAM_DOMAIN": "https://<team-name>.cloudflareaccess.com",
"ACCESS_AUDIENCE": "<Access-application-aud-tag>",
"OPERATOR_EMAIL": "operator@example.com"
```

The Worker validates `Cf-Access-Jwt-Assertion` against the Access certificate endpoint, issuer, audience, expiry, and configured email. A missing, invalid, or disallowed assertion receives no consent state and cannot reach `completeAuthorization()`. Keep the Access application path-scoped so OAuth token and discovery endpoints remain owned by the OAuth Provider.

## 6. Deploy

```bash
npm install
npm run deploy
```

`wrangler deploy` prints the deployed Worker's `*.workers.dev` URL, or your configured custom domain if `wrangler.jsonc` has a `routes` entry.

## 7. Verify

```bash
curl -s https://<worker-hostname>/health
# {"ok":true}

curl -s -o /dev/null -w '%{http_code}\n' https://<worker-hostname>/mcp
# 401 -- unauthenticated /mcp is rejected
```

An unauthenticated request to `/mcp` must return `401` with a `WWW-Authenticate: Bearer ...` challenge pointing at `/.well-known/oauth-protected-resource/mcp`. See [`OAUTH.md`](OAUTH.md) for the full authorization flow and how to verify a request succeeds after authorization.

## Operator authentication and consent

An authenticated Access request to `GET /authorize` validates the OAuth request and known client, then displays the client ID, client name, and requested scopes. The operator must submit an explicit `Approve` action. `POST /authorize` requires the one-use consent state, a CSRF token in both the form and an HttpOnly cookie, and the same Access subject that opened the page. Durable Object storage transactionally consumes the state, so concurrent submissions can produce at most one grant. `Deny` redirects with `access_denied` and creates no grant.

The OAuth Provider remains responsible for request validation, PKCE, authorization codes, access and refresh tokens, refresh-token rotation, DCR/CIMD, and bearer validation. This Worker only owns Access identity verification and consent.

## Secrets and configuration

- `GATEWAY_ACCESS_CLIENT_ID` and `GATEWAY_ACCESS_CLIENT_SECRET` are Wrangler secrets created in step 3, authenticating the Worker to the Tunnel-protected gateway origin. They are not present in repository files or Worker responses.
- `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, and `OPERATOR_EMAIL` (step 5) are not secrets in the `wrangler secret put` sense -- Cloudflare Access authenticates the operator and the Worker only validates its assertion against them.
- `OAUTH_KV` holds provider-managed state (registered clients, grants, and tokens) as a binding, not a secret value. `CONSENT_STATE` holds short-lived consent state in Durable Object storage, which atomically consumes it so concurrent submissions can produce at most one grant.
- `GATEWAY_ORIGIN` and the KV namespace ID are deployment configuration. Review them before publishing a fork; neither replaces the Worker Access secrets. Never commit `wrangler.jsonc` with a filled-in KV namespace `id` from a shared/production account into a public fork without checking your organization's disclosure policy for resource IDs; the ID alone does not grant access without account credentials.
- If a future auth provider is added, store its client secret with `npx wrangler secret put <NAME>`.
