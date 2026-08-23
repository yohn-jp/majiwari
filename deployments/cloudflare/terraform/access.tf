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
