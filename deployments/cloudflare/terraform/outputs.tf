output "mcp_access_audience_tag" {
  value       = cloudflare_zero_trust_access_application.mcp.aud
  description = "Copy into deployment-profile.json's mcpAccess.audience value."
}

output "gateway_vpc_service_id" {
  value       = cloudflare_connectivity_directory_service.gateway.service_id
  description = "Copy into deployment-profile.json's gatewayVpcServiceId value. Identifies the Workers VPC Service binding the Worker uses to reach the gateway."
}
