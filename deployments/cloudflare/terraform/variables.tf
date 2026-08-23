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
