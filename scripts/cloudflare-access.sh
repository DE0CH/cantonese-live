#!/bin/bash
# One-time (idempotent) Cloudflare Access setup for cantonese.deyaochen.com: Deyao's email (one-time PIN) for the web
# page, and the service token "cantonese-ios" for the iOS app. Needs CLOUDFLARE_API (Access apps, policies and
# service tokens). A fresh service token's id/secret are written to $OUT (default ~/drop/cantonese-ios-token.json)
# and never printed; they go into the repo's GitHub secrets CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.
# ROTATE=1 mints a new token, moves the policy to it and deletes the old one (a secret can't be read back).
set -euo pipefail
ACCOUNT_ID=ee3b4deef856baf11e1a67b242438325
HOST=cantonese.deyaochen.com
OWNER_EMAIL=chendeyao000@gmail.com
OUT=${OUT:-$HOME/drop/cantonese-ios-token.json}
API=https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access
api() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API" -H "Content-Type: application/json" "$@"; }

OLD=$(api "$API/service_tokens" | jq -r '.result[]|select(.name=="cantonese-ios")|.id')
ST_ID=$(head -1 <<<"$OLD")
if [ -z "$ST_ID" ] || [ "${ROTATE:-}" = 1 ]; then
  mkdir -p "$(dirname "$OUT")"; umask 077
  api -X POST "$API/service_tokens" --data '{"name":"cantonese-ios","duration":"forever"}' \
    | jq '{client_id:.result.client_id, client_secret:.result.client_secret}' > "$OUT"
  ST_ID=$(api "$API/service_tokens" | jq -r '.result[]|select(.name=="cantonese-ios")|.id' | grep -vxF "$OLD" | head -1)
  echo "new service token cantonese-ios -> $OUT"
fi

body=$(jq -nc --arg d "$HOST" '{name:"Cantonese live",domain:$d,type:"self_hosted",session_duration:"720h",app_launcher_visible:false}')
APP=$(api "$API/apps" | jq -r --arg d "$HOST" '.result[]|select(.domain==$d)|.id' | head -1)
if [ -n "$APP" ]; then api -X PUT "$API/apps/$APP" --data "$body" >/dev/null
else APP=$(api -X POST "$API/apps" --data "$body" | jq -r .result.id); fi
for p in $(api "$API/apps/$APP/policies" | jq -r '.result[].id'); do api -X DELETE "$API/apps/$APP/policies/$p" >/dev/null; done
api -X POST "$API/apps/$APP/policies" --data "$(jq -nc --arg e "$OWNER_EMAIL" '{name:"owner",decision:"allow",precedence:1,include:[{email:{email:$e}}]}')" | jq -e .success >/dev/null
api -X POST "$API/apps/$APP/policies" --data "$(jq -nc --arg t "$ST_ID" '{name:"ios-app",decision:"non_identity",precedence:2,include:[{service_token:{token_id:$t}}]}')" | jq -e .success >/dev/null
echo "Access app $HOST: owner email + service token cantonese-ios"
[ "${ROTATE:-}" = 1 ] && for t in $OLD; do api -X DELETE "$API/service_tokens/$t" >/dev/null && echo "deleted the old token"; done
true
