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

## 5. Deploy

```bash
npm install
npm run deploy
```

`wrangler deploy` prints the deployed Worker's `*.workers.dev` URL, or your configured custom domain if `wrangler.jsonc` has a `routes` entry.

## 6. Verify

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

## Secrets and configuration

- `GATEWAY_ACCESS_CLIENT_ID` and `GATEWAY_ACCESS_CLIENT_SECRET` are Wrangler secrets created in step 3. They are not present in repository files or Worker responses.
- `OAUTH_KV` holds provider-managed state (registered clients, grants, and tokens) as a binding, not a secret value.
- `GATEWAY_ORIGIN` and the KV namespace ID are deployment configuration. Review them before publishing a fork; neither replaces the Worker Access secrets.
