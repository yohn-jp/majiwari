output "access_application_audience_tag" {
  value       = cloudflare_zero_trust_access_application.gateway.aud
  description = "Copy into config.example.yml's ACCESS_APPLICATION_AUDIENCE_TAG value."
}

output "worker_access_client_id" {
  value       = cloudflare_zero_trust_access_service_token.worker.client_id
  description = "Pipe into Wrangler secret GATEWAY_ACCESS_CLIENT_ID; do not put in wrangler.jsonc."
}

output "worker_access_client_secret" {
  value       = cloudflare_zero_trust_access_service_token.worker.client_secret
  description = "Pipe directly into Wrangler secret GATEWAY_ACCESS_CLIENT_SECRET; do not print or commit."
  sensitive   = true
}

output "mcp_access_audience_tag" {
  value       = cloudflare_zero_trust_access_application.mcp.aud
  description = "Copy into deployment-profile.json's mcpAccess.audience value."
}
