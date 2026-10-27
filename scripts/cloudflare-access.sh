#!/bin/bash
# Idempotent Cloudflare Access setup for cantonese.deyaochen.com: only Deyao's email (one-time PIN) gets in. Needs
# CLOUDFLARE_API (Access apps, policies and service tokens). The iOS app transcribes on the phone and never calls the
# relay, so the old "cantonese-ios" service token is deleted if it still exists.
set -euo pipefail
ACCOUNT_ID=ee3b4deef856baf11e1a67b242438325
HOST=cantonese.deyaochen.com
OWNER_EMAIL=chendeyao000@gmail.com
API=https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access
api() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API" -H "Content-Type: application/json" "$@"; }

body=$(jq -nc --arg d "$HOST" '{name:"Cantonese live",domain:$d,type:"self_hosted",session_duration:"720h",app_launcher_visible:false}')
APP=$(api "$API/apps" | jq -r --arg d "$HOST" '.result[]|select(.domain==$d)|.id' | head -1)
if [ -n "$APP" ]; then api -X PUT "$API/apps/$APP" --data "$body" >/dev/null
else APP=$(api -X POST "$API/apps" --data "$body" | jq -r .result.id); fi
for p in $(api "$API/apps/$APP/policies" | jq -r '.result[].id'); do api -X DELETE "$API/apps/$APP/policies/$p" >/dev/null; done
api -X POST "$API/apps/$APP/policies" --data "$(jq -nc --arg e "$OWNER_EMAIL" '{name:"owner",decision:"allow",precedence:1,include:[{email:{email:$e}}]}')" | jq -e .success >/dev/null
echo "Access app $HOST: owner email only"
for t in $(api "$API/service_tokens" | jq -r '.result[]|select(.name=="cantonese-ios")|.id'); do
  api -X DELETE "$API/service_tokens/$t" >/dev/null && echo "deleted service token cantonese-ios"
done
