# Cloudflare Access provisioning

This directory provisions the Access boundary for the Named Tunnel:

- one dedicated Service Token for the Worker
- one `non_identity` Service Auth policy that includes only that token
- one self-hosted Access application for the Tunnel hostname

The Terraform provider reads `CLOUDFLARE_API_TOKEN` from the environment. The
token needs `Access: Apps and Policies Write` and `Access: Service Tokens Write`.
Do not put it in a `.tfvars` file or command-line argument.

Initialize and apply with the account ID and exact Tunnel hostname:

```bash
export CLOUDFLARE_API_TOKEN='…'
terraform init
terraform apply \
  -var='cloudflare_account_id=<ACCOUNT_ID>' \
  -var='gateway_hostname=majiwari-gateway.internal.example.com'
```

Terraform state contains the generated service-token secret. Use encrypted or
remote state and never commit state files. The local `.gitignore` is a guard,
not a replacement for protected state storage.

Copy the audience tag into `deployments/cloudflare/tunnel/config.example.yml`,
then provision Worker secrets without printing their values:

```bash
cd deployments/cloudflare/worker
terraform -chdir=../terraform output -raw worker_access_client_id | npx wrangler secret put GATEWAY_ACCESS_CLIENT_ID
terraform -chdir=../terraform output -raw worker_access_client_secret | npx wrangler secret put GATEWAY_ACCESS_CLIENT_SECRET
```

The secret output is piped directly to Wrangler and is not placed in a
repository file. Rotate the Service Token and repeat both secret commands
when it expires or is compromised.
