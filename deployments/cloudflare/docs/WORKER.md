# Cloudflare Worker

The Worker is the only public entry point. It terminates OAuth and proxies `/mcp` to the gateway's Tunnel origin. It never exposes the gateway's hostname to a client.

## Prerequisites

- [`TUNNEL.md`](TUNNEL.md) completed: a Named Tunnel hostname reachable from Cloudflare
- a Cloudflare account, `wrangler` authenticated (`npx wrangler login`)

## 1. Create the OAuth KV namespace

`@cloudflare/workers-oauth-provider` stores clients, grants, and tokens in a KV namespace:

```bash
cd deployments/cloudflare/worker
npx wrangler kv namespace create OAUTH_KV
```

Copy the printed `id` into `wrangler.jsonc`'s `kv_namespaces[0].id`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

## 2. Point the Worker at the Tunnel origin

Edit `wrangler.jsonc`'s `vars.GATEWAY_ORIGIN` to the Tunnel hostname from `TUNNEL.md`, including the `/mcp` path:

```jsonc
"vars": {
  "GATEWAY_ORIGIN": "https://majiwari-gateway.internal.example.com/mcp"
}
```

This value is never sent to the client -- the Worker only ever proxies to it server-side.

## 3. Set the public hostname in the OAuth resource metadata

Edit `src/index.ts`'s `resourceMetadata.resource` and `resourceMetadata.authorization_servers[0]` to this Worker's actual public hostname (the one you'll register in ChatGPT), e.g. `https://mcp.example.com`. This is compiled into the Worker at deploy time, not read from an environment variable -- `OAuthProvider`'s configuration is constructed at module load, before any request's `env` exists.

## 4. Deploy

```bash
npm install
npm run deploy
```

`wrangler deploy` prints the deployed Worker's `*.workers.dev` URL, or your configured custom domain if `wrangler.jsonc` has a `routes` entry.

## 5. Verify

```bash
curl -s https://<worker-hostname>/health
# {"ok":true}

curl -s -o /dev/null -w '%{http_code}\n' https://<worker-hostname>/mcp
# 401 -- unauthenticated /mcp is rejected
```

An unauthenticated request to `/mcp` must return `401` with a `WWW-Authenticate: Bearer ...` challenge pointing at `/.well-known/oauth-protected-resource/mcp`. See [`OAUTH.md`](OAUTH.md) for the full authorization flow and how to verify a request succeeds after authorization.

## v0 authorization model

This Worker's `/authorize` handler grants access to a single fixed operator identity (`self-hosted-operator`) without a separate identity provider -- see `src/index.ts`. This matches the v0 self-host scope: the person who deploys the Worker is its only intended user. There is no username/password or third-party login step, and no additional secret to provision for it.

Before granting access to more than one person, replace that handler with a real authentication and consent step (see the `AuthProps`/`completeAuthorization` call in `src/index.ts` and the [`@cloudflare/workers-oauth-provider` README](https://github.com/cloudflare/workers-oauth-provider) for the extension points). That is out of scope for v0.

## Secrets

Nothing in this Worker configuration is a secret in the `wrangler secret put` sense for v0 (no third-party IdP client ID/secret is used). `OAUTH_KV` holds provider-managed state (registered clients, grants, tokens) and is provisioned as a binding, not a secret value. If a future auth provider is added, store its client secret with:

```bash
npx wrangler secret put <NAME>
```

Never commit `wrangler.jsonc` with a filled-in KV namespace `id` from a shared/production account into a public fork without checking your organization's disclosure policy for resource IDs; the ID alone does not grant access without account credentials, but treat it as configuration to review before publishing.
