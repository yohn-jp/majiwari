# OAuth

`/mcp` is protected by [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider), an OAuth 2.1 authorization server implementation for Cloudflare Workers. This Worker does not implement its own token issuance or validation -- the library does, backed by the `OAUTH_KV` namespace.

## Discovery flow

An MCP client (ChatGPT) discovers authorization in two stages, per the [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery):

1. Client sends an unauthenticated request to `/mcp`.
2. Worker returns `401` with:
   ```http
   WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://<worker-host>/.well-known/oauth-protected-resource/mcp"
   ```
3. Client fetches `/.well-known/oauth-protected-resource/mcp` -- identifies the authorization server via `authorization_servers`.
4. Client fetches `/.well-known/oauth-authorization-server` -- RFC 8414 metadata: `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, supported grant types, PKCE methods.
5. Client registers (if using dynamic client registration against `/oauth/register`) or uses a pre-configured client, then drives the user through `/authorize`.
6. Client exchanges the authorization code at `/oauth/token` and calls `/mcp` with `Authorization: Bearer <token>`.

None of this is implemented by hand in `src/index.ts` beyond the `/authorize` consent step -- `OAuthProvider` serves the `.well-known` documents, `/oauth/token`, and `/oauth/register` automatically from the constructor options.

## What this Worker configures

In `src/index.ts`:

- `apiRoute: "/mcp"` / `apiHandler: McpProxyHandler` -- every request to `/mcp` is validated against a bearer token before `McpProxyHandler.fetch` ever runs. The proxy handler itself does not parse or check tokens.
- `authorizeEndpoint: "/authorize"` -- handled by `defaultHandler`, which is this repository's code. It validates the request (`parseAuthRequest`), confirms the client is known (`lookupClient`), and grants the v0 fixed operator identity (see [`WORKER.md`](WORKER.md#v0-authorization-model)).
- `tokenEndpoint`, `clientRegistrationEndpoint` -- served entirely by the library.
- `scopesSupported: ["mcp:invoke"]` -- the only scope this deployment grants.

## Verifying end to end

After deploying (see [`WORKER.md`](WORKER.md)):

```bash
# 1. Unauthenticated /mcp is rejected
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-host>/mcp
# expect: 401

# 2. Protected resource metadata is served
curl -s https://<worker-host>/.well-known/oauth-protected-resource/mcp | jq .

# 3. Authorization server metadata is served
curl -s https://<worker-host>/.well-known/oauth-authorization-server | jq .
```

Full authorization-code + token exchange is easiest to verify through an actual MCP client (ChatGPT, or `npx @modelcontextprotocol/inspector`) rather than by hand with `curl`, since it involves a browser redirect through `/authorize` and PKCE. See [`CHATGPT_SETUP.md`](../../../docs/CHATGPT_SETUP.md) for the ChatGPT-side registration steps.

## Secrets

No third-party identity provider secret exists in v0 (see [`WORKER.md`](WORKER.md#v0-authorization-model)). `OAUTH_KV` holds the provider's own state (clients, grants, tokens) and is never read or written directly by this repository's code outside the `OAuthHelpers` interface the library provides. Nothing OAuth-related is committed to this repository.
