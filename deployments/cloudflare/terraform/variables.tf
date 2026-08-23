variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account that owns the Access application and service token."
}

variable "gateway_hostname" {
  type        = string
  description = "Named Tunnel hostname to protect, without a scheme or path."
}

variable "service_token_duration" {
  type        = string
  description = "Lifetime of the Worker-only Access service token."
  default     = "8760h"
}

variable "public_mcp_hostname" {
  type        = string
  description = "Public hostname of the Majiwari MCP endpoint, without a scheme or path. Must match deployment-profile.json's publicMcpUrl origin."
}

variable "mcp_access_allowed_email_domains" {
  type        = list(string)
  description = "Email domains allowed through the /mcp Managed OAuth Access policy. Empty allows everyone in the identity provider(s) configured on the account."
  default     = []
}

variable "mcp_access_token_lifetime" {
  type        = string
  description = "Lifetime of Managed OAuth access tokens issued for /mcp."
  default     = "1h"
}

variable "mcp_access_session_duration" {
  type        = string
  description = "Lifetime of the underlying Access session backing Managed OAuth grants for /mcp."
  default     = "24h"
}

variable "mcp_access_allowed_redirect_uris" {
  type        = list(string)
  description = "Redirect URIs allowed for OAuth clients dynamically registered against the /mcp Managed OAuth boundary (for example, an MCP client's callback URL). Each entry must use https and may end in /* to match all sub-paths."
  default     = []
}
