#!/usr/bin/env bash
# Runs a command with a short-lived Cloudflare API token scoped to exactly
# the permission groups requested, then revokes the token on exit.
#
# The standing token used to run this script (CLOUDFLARE_API_TOKEN in the
# environment already) needs only "Account API Tokens" Edit -- nothing else.
# Every other permission this repository's Terraform needs (Access: Apps
# Write, Access: Policies Write, Access: Service Tokens Write, Connectivity
# Directory Admin, ...) is granted only to the short-lived token this script
# creates, for the duration of one command.
#
# Permission group names must match exactly what this account's
# /accounts/{id}/tokens/permission_groups returns -- Cloudflare splits most
# groups by Read/Write/Revoke (there is no bare "Access: Apps" or "Zero
# Trust" group). List them with:
#   curl -sS "$api/accounts/$account_id/tokens/permission_groups" \
#     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq -r '.result[].name'
#
# Usage:
#   with-scoped-token.sh <account_id> <permission group name>[,<name>...] -- <command...>
#
# Example:
#   with-scoped-token.sh cbde0d943a9f28b00cd34bb12ebd142d \
#     "Access: Apps Write,Access: Policies Write,Access: Service Tokens Write,Connectivity Directory Admin" \
#     -- terraform -chdir=deployments/cloudflare/terraform apply -var=...
#
# Requires: curl, jq. Reads CLOUDFLARE_API_TOKEN from the environment for the
# standing token; the short-lived token is exported as CLOUDFLARE_API_TOKEN
# for the wrapped command only, and is never printed.

set -euo pipefail

if [ "$#" -lt 4 ] || [ "$3" != "--" ]; then
  echo "usage: $0 <account_id> <permission group name>[,<name>...] -- <command...>" >&2
  exit 1
fi

account_id="$1"
permission_names_csv="$2"
shift 3

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN must be set to the standing token (Account API Tokens Edit only) before running this script" >&2
  exit 1
fi

standing_token="$CLOUDFLARE_API_TOKEN"
api="https://api.cloudflare.com/client/v4"

all_groups_response=$(curl -sS "$api/accounts/$account_id/tokens/permission_groups" \
  -H "Authorization: Bearer $standing_token")

if [ "$(echo "$all_groups_response" | jq -r '.success')" != "true" ]; then
  echo "failed to list permission groups: $(echo "$all_groups_response" | jq -c '.errors')" >&2
  exit 1
fi

permission_group_ids="[]"
IFS=',' read -ra names <<< "$permission_names_csv"
for name in "${names[@]}"; do
  id=$(echo "$all_groups_response" | jq -r --arg name "$name" '.result[] | select(.name == $name) | .id' | head -1)
  if [ -z "$id" ]; then
    echo "permission group not found in this account: $name" >&2
    exit 1
  fi
  permission_group_ids=$(echo "$permission_group_ids" | jq --arg id "$id" '. + [{"id": $id}]')
done

expires_on=$(date -u -d '+4 hours' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -v+4H '+%Y-%m-%dT%H:%M:%SZ')

create_payload=$(jq -n \
  --arg name "majiwari-scoped-token-$(date +%s)" \
  --arg account_id "$account_id" \
  --arg expires_on "$expires_on" \
  --argjson permission_groups "$permission_group_ids" \
  '{
    name: $name,
    expires_on: $expires_on,
    policies: [{
      effect: "allow",
      resources: {("com.cloudflare.api.account." + $account_id): "*"},
      permission_groups: $permission_groups
    }]
  }')

create_response=$(curl -sS -X POST "$api/accounts/$account_id/tokens" \
  -H "Authorization: Bearer $standing_token" \
  -H "Content-Type: application/json" \
  --data "$create_payload")

if [ "$(echo "$create_response" | jq -r '.success')" != "true" ]; then
  echo "failed to create scoped token: $(echo "$create_response" | jq -c '.errors')" >&2
  exit 1
fi

token_id=$(echo "$create_response" | jq -r '.result.id')
token_value=$(echo "$create_response" | jq -r '.result.value')

cleanup() {
  curl -sS -X DELETE "$api/accounts/$account_id/tokens/$token_id" \
    -H "Authorization: Bearer $standing_token" > /dev/null
}
trap cleanup EXIT

CLOUDFLARE_API_TOKEN="$token_value" "$@"
