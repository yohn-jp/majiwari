# The Worker's actual path to the gateway: a Workers VPC Service binding,
# routed over the same cloudflared Tunnel via Cloudflare's internal
# connectivity-directory path (Iris/Apollo), not the public zone. This never
# touches zone-level WAF, bot management, or DNS -- the gateway has no public
# hostname on this path at all. See deployments/cloudflare/docs/WORKER.md.
resource "cloudflare_connectivity_directory_service" "gateway" {
  account_id = var.cloudflare_account_id
  name       = "majiwari-gateway"
  type       = "http"
  http_port  = 8787

  host = {
    ipv4 = "127.0.0.1"
    network = {
      tunnel_id = var.gateway_tunnel_id
    }
  }
}

resource "cloudflare_zero_trust_access_policy" "mcp" {
  account_id = var.cloudflare_account_id
  name       = "Allow Majiwari MCP clients"
  decision   = "allow"

  include = (
    length(var.mcp_access_allowed_email_domains) == 0 && length(var.mcp_access_allowed_emails) == 0
    ? [{ everyone = {} }]
    : concat(
      [for domain in var.mcp_access_allowed_email_domains : { email_domain = { domain = domain } }],
      [for address in var.mcp_access_allowed_emails : { email = { email = address } }]
    )
  )
}

# The public Managed OAuth boundary for the Majiwari MCP endpoint.
resource "cloudflare_zero_trust_access_application" "mcp" {
  account_id                = var.cloudflare_account_id
  name                      = "Majiwari MCP"
  domain                    = var.public_mcp_hostname
  type                      = "mcp"
  allowed_idps              = length(var.mcp_access_allowed_idps) > 0 ? var.mcp_access_allowed_idps : null
  auto_redirect_to_identity = length(var.mcp_access_allowed_idps) == 1 ? true : null

  policies = [{
    id         = cloudflare_zero_trust_access_policy.mcp.id
    precedence = 1
  }]

  oauth_configuration = {
    enabled = true
    grant = {
      access_token_lifetime = var.mcp_access_token_lifetime
      session_duration      = var.mcp_access_session_duration
    }
    dynamic_client_registration = {
      enabled      = true
      allowed_uris = var.mcp_access_allowed_redirect_uris
    }
  }
}
