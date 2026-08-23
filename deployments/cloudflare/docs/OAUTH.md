# Managed OAuth

`/mcp` is protected by [Cloudflare Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), a native capability of a Cloudflare Access Application. This Worker does not implement OAuth authorization-code issuance, token issuance, dynamic client registration, or discovery -- Cloudflare Access does, as the account's own Zero Trust boundary in front of the Worker. There is no repository-owned KV, Durable Object, or consent flow backing any of this.

## How a request reaches /mcp

1. An MCP client requests `/mcp` on the public hostname.
2. Cloudflare Access, configured as an `mcp`-type Access Application with `oauth_configuration.enabled = true` (see [`../terraform/access.tf`](../terraform/access.tf)), drives the client through a standard OAuth 2.0 authorization-code flow -- discovery, dynamic client registration, user authentication against the account's identity provider(s), and token issuance are all handled by Cloudflare, not by this Worker.
3. Once Access authorizes the request, it resolves the client's token into the caller's identity and forwards the request to the Worker with a signed `Cf-Access-Jwt-Assertion` header, indistinguishable in shape from a browser-authenticated Access request.
4. The Worker verifies that assertion (`src/access.ts`, `verifyAccessAssertion`) -- signature, issuer, audience, and expiry -- and, if valid, proxies the request to the gateway's Tunnel origin (`src/index.ts`). An invalid or missing assertion is rejected with `403` before the request reaches the proxy.

The Worker trusts the Access Policy attached to the `mcp` Access Application for *who* is allowed through; it does not re-implement identity or scope policy. See [`../terraform/access.tf`](../terraform/access.tf) for the policy that governs this.

## What this Worker validates

`verifyAccessAssertion` in `src/access.ts`:

- Confirms the JWT's signature against the Access team's published JWKS (`<team-domain>/cdn-cgi/access/certs`, or `ACCESS_CERTS_URL` if overridden).
- Confirms `iss` matches `MCP_ACCESS_TEAM_DOMAIN` and `aud` matches `MCP_ACCESS_AUDIENCE` -- both scoped specifically to the `/mcp` Access Application, not the separate Tunnel-origin Access Application described in [`TUNNEL.md`](TUNNEL.md).
- Confirms the token is unexpired and carries a non-empty `sub` and `email` claim.

It does not check the caller's identity against an allowlist in code -- that authorization decision belongs to the Access Policy, not the Worker.

## Verifying end to end

```bash
# 1. Unauthenticated /mcp is rejected
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-host>/mcp
# expect: 403 from the Worker, or a Cloudflare Access redirect/challenge in front of it

# 2. Retired endpoints are gone
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-host>/authorize
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-host>/oauth/token
# expect: 404 for both
```

Full authorization-code + token exchange is easiest to verify through an actual MCP client (ChatGPT, or `npx @modelcontextprotocol/inspector`) rather than by hand with `curl`, since Cloudflare Access drives a browser redirect and the OAuth exchange itself. See [`CHATGPT_SETUP.md`](../../../docs/CHATGPT_SETUP.md) for the ChatGPT-side registration steps against the Access-fronted endpoint.

## Secrets and configuration

`MCP_ACCESS_TEAM_DOMAIN` and `MCP_ACCESS_AUDIENCE` are non-secret Worker vars, generated from the deployment profile's `mcpAccess` (see [`WORKER.md`](WORKER.md)). The origin protection boundary's Access service-token credentials (`GATEWAY_ACCESS_CLIENT_ID` / `GATEWAY_ACCESS_CLIENT_SECRET`) remain Wrangler secret bindings, unrelated to and unweakened by this change. Nothing OAuth-related is committed to this repository; Cloudflare owns all OAuth state.

## Boundaries in this deployment, and where a Portal would fit

Four distinct things, not to be confused with each other:

- **Product endpoint**: this Worker's `/mcp`, independently usable by any MCP client today, with no dependency on the item below.
- **Managed OAuth Access layer**: the `mcp`-type Access Application in [`../terraform/access.tf`](../terraform/access.tf), described on this page. This is what a client actually authenticates against.
- **Protected Tunnel origin**: the separate `self_hosted` Access Application and Service Token in the same file, described in [`TUNNEL.md`](TUNNEL.md). This protects the Worker-to-gateway hop and has nothing to do with client-facing OAuth.
- **Cloudflare MCP Portal** (optional, not deployed by this repository): an account-level aggregation point that can front multiple MCP server applications, including this one, behind a single Portal URL. Registering this Worker's `/mcp` Access Application behind a future Portal is additive -- it does not require changing the Managed OAuth Access Application, the Worker, or the gateway described here.
