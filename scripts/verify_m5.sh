#!/bin/zsh
# M5 HTTP/WS checks against the running container. Prints PASS/FAIL only —
# never the token.
set -u
B=http://localhost:8000
TOKEN=$(grep '^CATHQ_AUTH_TOKEN=' /Users/kolt/Downloads/cat-hq/.env | cut -d= -f2- | tr -d '[:space:]')
fails=0
chk() { # chk <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (want $2 got $3)"; fails=$((fails+1)); fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

chk "/health open"            200 "$(code $B/health)"
chk "/ serves index.html"     "<!doctype html>" "$(curl -s $B/ | head -c 15)"
chk "/devices no token → 401" 401 "$(code $B/devices)"
chk "/devices bad token → 401" 401 "$(code -H 'Authorization: Bearer nope' $B/devices)"
chk "/devices real token → 200" 200 "$(code -H "Authorization: Bearer $TOKEN" $B/devices)"
chk "/events real token → 200" 200 "$(code -H "Authorization: Bearer $TOKEN" "$B/events?limit=1")"
chk "/events no token → 401"  401 "$(code $B/events)"
# NB: never probe POST /devices/*/clean|feed here — those MOVE HARDWARE if
# auth isn't deployed yet (learned the hard way, 2026-07-05). Auth is applied
# at router level, so the GET 401 checks above cover the whole router.
chk "/manifest.webmanifest"   200 "$(code $B/manifest.webmanifest)"
chk "/sw.js"                  200 "$(code $B/sw.js)"
chk "/icons/icon-192.png"     200 "$(code $B/icons/icon-192.png)"
chk "SPA fallback route"      "<!doctype html>" "$(curl -s $B/some/deep/route | head -c 15)"
chk "unknown asset 404s? no — SPA falls back" 200 "$(code $B/definitely-not-an-api-path)"

ASSET=$(curl -s $B/ | grep -o 'assets/index-[^"]*\.js' | head -1)
CACHE=$(curl -s -D - -o /dev/null $B/$ASSET | grep -i '^cache-control' | tr -d '\r')
chk "asset immutable cache"   "cache-control: public, max-age=31536000, immutable" "$CACHE"
IDXCACHE=$(curl -s -D - -o /dev/null $B/ | grep -i '^cache-control' | tr -d '\r')
chk "index no-cache"          "cache-control: no-cache" "$IDXCACHE"

ws_status() {
  curl -s -i --max-time 2 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H "Sec-WebSocket-Protocol: cathq, $1" \
    $B/ws 2>/dev/null | head -1 | awk '{print $2}'
}
chk "WS good token → 101"     101 "$(ws_status "$TOKEN")"
chk "WS bad token → 403"      403 "$(ws_status not-the-token)"
SUBPROTO=$(curl -s -i --max-time 2 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H "Sec-WebSocket-Protocol: cathq, $TOKEN" $B/ws 2>/dev/null | grep -i '^sec-websocket-protocol' | tr -d '\r')
chk "WS echoes cathq subprotocol" "sec-websocket-protocol: cathq" "$SUBPROTO"

echo "---"
[ $fails -eq 0 ] && echo "ALL PASS" || echo "$fails FAILURES"
exit $fails
