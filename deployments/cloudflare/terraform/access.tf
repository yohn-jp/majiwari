resource "cloudflare_zero_trust_access_service_token" "worker" {
  account_id = var.cloudflare_account_id
  name       = "Majiwari Worker to gateway Tunnel"
  duration   = var.service_token_duration

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "worker" {
  account_id = var.cloudflare_account_id
  name       = "Allow Majiwari Worker service token"
  decision   = "non_identity"

  include = [{
    service_token = {
      token_id = cloudflare_zero_trust_access_service_token.worker.id
    }
  }]
}

resource "cloudflare_zero_trust_access_application" "gateway" {
  account_id                = var.cloudflare_account_id
  name                      = "Majiwari gateway Tunnel"
  domain                    = var.gateway_hostname
  type                      = "self_hosted"
  auto_redirect_to_identity = false
  service_auth_401_redirect = true

  policies = [{
    id         = cloudflare_zero_trust_access_policy.worker.id
    precedence = 1
  }]
}

resource "cloudflare_zero_trust_access_policy" "mcp" {
  account_id = var.cloudflare_account_id
  name       = "Allow Majiwari MCP clients"
  decision   = "allow"

  include = length(var.mcp_access_allowed_email_domains) == 0 ? [{ everyone = {} }] : [
    for domain in var.mcp_access_allowed_email_domains : { email_domain = { domain = domain } }
  ]
}

# The public Managed OAuth boundary for the Majiwari MCP endpoint. Distinct
# from cloudflare_zero_trust_access_application.gateway, which protects the
# private Tunnel origin behind this Worker; that boundary is unaffected here.
resource "cloudflare_zero_trust_access_application" "mcp" {
  account_id = var.cloudflare_account_id
  name       = "Majiwari MCP"
  domain     = var.public_mcp_hostname
  type       = "mcp"

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
  }
}
