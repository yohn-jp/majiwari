# Cloudflare Access and Workers VPC provisioning

This directory provisions two independent boundaries:

- the private path from Worker to gateway: a Workers VPC Service
  (`cloudflare_connectivity_directory_service.gateway`) that routes over the
  existing cloudflared Tunnel through Cloudflare's internal
  connectivity-directory path, never touching the public zone's DNS or WAF.
  The Worker proves it owns the binding simply by being the Worker the
  service was bound to -- there is no origin-side credential to provision or
  rotate.
- the public `/mcp` endpoint (client → Worker): one `mcp`-type Access
  application with Managed OAuth enabled (`oauth_configuration.enabled =
  true`), and an identity-based Access policy controlling which callers may
  complete the OAuth grant

A legacy self-hosted Access Application and Service Token for the Tunnel's
public hostname (`cloudflare_zero_trust_access_application.gateway`,
`cloudflare_zero_trust_access_service_token.worker`) are also provisioned but
unused by the Worker -- kept only as a rollback path back to the
public-hostname-plus-service-token design if the Workers VPC beta regresses.
See [`../docs/WORKER.md`](../docs/WORKER.md) for how the Worker actually
reaches the gateway today.

The Terraform provider reads `CLOUDFLARE_API_TOKEN` from the environment. The
token needs `Access: Apps Write`, `Access: Policies Write`, `Access: Service
Tokens Write` (for the legacy rollback path), and `Connectivity Directory
Admin` (to create the VPC Service). Do not put it in a `.tfvars` file or
command-line argument.

Prefer not minting a long-lived token with this much scope at all --
[`../scripts/with-scoped-token.sh`](../scripts/with-scoped-token.sh) mints a
short-lived (4-hour), exactly-scoped token from a standing token that only
needs `Account API Tokens` Edit, runs one command with it, and revokes it on
exit:

```bash
export CLOUDFLARE_API_TOKEN='<standing token, Account API Tokens Edit only>'
../scripts/with-scoped-token.sh <ACCOUNT_ID> \
  "Access: Apps Write,Access: Policies Write,Access: Service Tokens Write,Connectivity Directory Admin" \
  -- terraform apply -var='cloudflare_account_id=<ACCOUNT_ID>' ...
```

## One-time API-token bootstrap

`wrangler login` and `cloudflared tunnel login` authenticate different
Cloudflare clients. Neither command creates or exposes the API token required
by this Terraform configuration. Cloudflare shows a newly created API token
only once, so an existing token cannot be recovered by this repository or by
the Wrangler OAuth session.

For the first deployment, an account administrator should open the direct
[API Tokens page](https://dash.cloudflare.com/profile/api-tokens), choose
`Create Token` → `Custom token`, restrict the token to the target account, and
grant, account-scoped, all four of:

- `Access: Policies Write`
- `Access: Apps Write`
- `Access: Service Tokens Write`
- `Connectivity Directory Admin`

Permission group names are account-specific and can change as Cloudflare
ships permission-picker updates; if a name here doesn't match what the
picker shows, list this account's actual names before guessing:

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/tokens/permission_groups" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq -r '.result[].name'
```

`Access: Service Tokens Write` is required to create a Service Token (`POST
.../access/service_tokens`, used by
`cloudflare_zero_trust_access_service_token`). `Connectivity Directory
Admin` is required separately to create the Workers VPC Service
(`cloudflare_connectivity_directory_service.gateway`), which references a
cloudflared Tunnel by ID. Workers VPC is a beta product as of this writing,
so double-check the permission picker's exact wording against the account in
use if token creation fails with a scope error here.

Only this one-time bootstrap token needs to carry all four permissions, and
only long enough to run `terraform apply` once or twice by hand. For repeat
or automated applies, mint it as a short-lived scoped token instead of a
long-lived one -- see `with-scoped-token.sh` above.

Inject the resulting value into the shell or CI secret store that runs
Terraform. Never paste it into chat, a profile, `.tfvars`, Terraform state
outside protected storage, or a command argument:

```bash
export CLOUDFLARE_API_TOKEN='(paste only into the protected shell prompt)'
test -n "$CLOUDFLARE_API_TOKEN" && echo "CLOUDFLARE_API_TOKEN is set"
```

If the deployment is run by an agent or CI worker, the secret must be injected
into that worker's process environment; setting it in a separate local shell
does not make it available to the worker. A preflight should stop with this
instruction when the variable is absent.

Initialize and apply with the account ID, the Tunnel hostname (legacy
rollback path only), the Tunnel ID (used by the Workers VPC Service), and the
public MCP hostname (the origin of `deployment-profile.json`'s
`publicMcpUrl`):

```bash
export CLOUDFLARE_API_TOKEN='…'
terraform init
terraform apply \
  -var='cloudflare_account_id=<ACCOUNT_ID>' \
  -var='gateway_hostname=majiwari-gateway.internal.example.com' \
  -var='gateway_tunnel_id=<CLOUDFLARED_TUNNEL_ID>' \
  -var='public_mcp_hostname=mcp.example.com' \
  -var='mcp_access_allowed_email_domains=["example.com"]' \
  -var='mcp_access_allowed_redirect_uris=["https://chatgpt.com/*"]'
```

`gateway_tunnel_id` is the cloudflared Tunnel's UUID, found in
`~/.cloudflared/config.yml`'s `tunnel:` field or via `cloudflared tunnel list`.

`mcp_access_allowed_email_domains` defaults to an empty list, which allows
everyone available through the account's configured identity provider(s) —
narrow it for anything beyond local testing. Creating an `mcp`-type Access
application requires the same `Access: Apps Write` / `Access: Policies
Write` permissions as above; Cloudflare has not published a narrower
permission specific to MCP applications as of this writing.

`mcp_access_allowed_redirect_uris` defaults to an empty list. Without it, the
`/mcp` Managed OAuth boundary's dynamic client registration rejects every
client's authorization redirect with `invalid_client_metadata: redirect_uri
is not allowed by the account configuration`, because
`oauth_configuration.dynamic_client_registration.allowed_uris` has nothing to
match against. Set it to each MCP client's callback pattern before
connecting that client — for ChatGPT, `https://chatgpt.com/*` (`/*` matches
both ChatGPT's stable `connector_platform_oauth_redirect` path and its
per-connector `connector/oauth/<id>` fallback in one entry).

Terraform state contains the legacy service-token secret (unused by the
Worker, kept for rollback). Use encrypted or remote state and never commit
state files. The local `.gitignore` is a guard, not a replacement for
protected state storage.

Copy the Tunnel application's audience tag into
`deployments/cloudflare/tunnel/config.example.yml`, the `/mcp` application's
audience tag (`terraform output -raw mcp_access_audience_tag`) into the
deployment profile's `mcpAccess.audience`, and the Workers VPC Service's ID
(`terraform output -raw gateway_vpc_service_id`) into the deployment
profile's `gatewayVpcServiceId`. There is no Worker secret to provision for
the gateway path -- the VPC Service binding itself is the only credential,
and Wrangler wires it up from the profile at deploy time (see
[`WORKER.md`](../docs/WORKER.md)).
