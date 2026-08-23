# Cloudflare Access provisioning

This directory provisions two independent Access boundaries:

- the private Tunnel origin (Worker → gateway): one dedicated Service Token,
  one `non_identity` Service Auth policy that includes only that token, and
  one self-hosted Access application for the Tunnel hostname
- the public `/mcp` endpoint (client → Worker): one `mcp`-type Access
  application with Managed OAuth enabled (`oauth_configuration.enabled =
  true`), and an identity-based Access policy controlling which callers may
  complete the OAuth grant

These are separate applications protecting separate hops; the Managed OAuth
boundary does not weaken or replace the Tunnel origin's Service Token
protection.

The Terraform provider reads `CLOUDFLARE_API_TOKEN` from the environment. The
token needs `Access: Apps and Policies Write` and `Access: Service Tokens Write`.
Do not put it in a `.tfvars` file or command-line argument.

## One-time API-token bootstrap

`wrangler login` and `cloudflared tunnel login` authenticate different
Cloudflare clients. Neither command creates or exposes the API token required
by this Terraform configuration. Cloudflare shows a newly created API token
only once, so an existing token cannot be recovered by this repository or by
the Wrangler OAuth session.

For the first deployment, an account administrator should open the direct
[API Tokens page](https://dash.cloudflare.com/profile/api-tokens), choose
`Create Token` → `Custom token`, restrict the token to the target account, and
grant, account-scoped, all three of:

- `Access: Apps` — Edit
- `Access: Policies` — Edit
- `Zero Trust` — Edit

`Access: Apps` and `Access: Policies` alone are not sufficient: creating a
Service Token (`POST .../access/service_tokens`, used by
`cloudflare_zero_trust_access_service_token`) fails with `403 auth.forbidden`
without the account-scoped `Zero Trust` permission group too, even when the
token owner is a Super Administrator on the account. There is no separate
`Access: Service Tokens` entry in the permission picker despite what the
Cloudflare docs describe.

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

Initialize and apply with the account ID, the Tunnel hostname, and the public
MCP hostname (the origin of `deployment-profile.json`'s `publicMcpUrl`):

```bash
export CLOUDFLARE_API_TOKEN='…'
terraform init
terraform apply \
  -var='cloudflare_account_id=<ACCOUNT_ID>' \
  -var='gateway_hostname=majiwari-gateway.internal.example.com' \
  -var='public_mcp_hostname=mcp.example.com' \
  -var='mcp_access_allowed_email_domains=["example.com"]'
```

`mcp_access_allowed_email_domains` defaults to an empty list, which allows
everyone available through the account's configured identity provider(s) —
narrow it for anything beyond local testing. Creating an `mcp`-type Access
application requires the same account-scoped `Zero Trust` and `Access: Apps`
/ `Access: Policies` Edit permissions as above; Cloudflare has not published a
narrower permission specific to MCP applications as of this writing.

Terraform state contains the generated service-token secret. Use encrypted or
remote state and never commit state files. The local `.gitignore` is a guard,
not a replacement for protected state storage.

Copy the Tunnel application's audience tag into
`deployments/cloudflare/tunnel/config.example.yml`, and the `/mcp`
application's audience tag (`terraform output -raw mcp_access_audience_tag`)
into the deployment profile's `mcpAccess.audience`. Then provision Worker
secrets without printing their values:

```bash
cd deployments/cloudflare/worker
terraform -chdir=../terraform output -raw worker_access_client_id | npx wrangler secret put GATEWAY_ACCESS_CLIENT_ID
terraform -chdir=../terraform output -raw worker_access_client_secret | npx wrangler secret put GATEWAY_ACCESS_CLIENT_SECRET
```

The secret output is piped directly to Wrangler and is not placed in a
repository file. Rotate the Service Token and repeat both secret commands
when it expires or is compromised.

This fails with Wrangler error code `7003` against the literal placeholder
account ID if `wrangler.jsonc`'s `account_id` has not yet been replaced by the
profile-driven build in [`WORKER.md`](../docs/WORKER.md). Run the profile flow
(`npm --workspace @majiwari/worker run deploy -- --profile <path> --dry-run`,
which generates `wrangler.profile.generated.jsonc`) before these commands, or
point `--config` at a config file with the real account ID.
