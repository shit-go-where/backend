#!/usr/bin/env bash
# Read-only probe of the live site: response headers, TLS and redirects, cold-start spread.
# Only GET requests, a few per minute, nothing that creates data. Run it from your own machine
# (ideally in Singapore) after every deploy that touches headers, domains or caching:
#
#   docs/probe-production.sh                       # https://shitgowhere.com
#   docs/probe-production.sh https://example.com   # another origin
#   LOCAL=http://localhost:3000 docs/probe-production.sh   # also diff manifest/robots against a local build
#
# Output is Markdown on stdout; redirect it to a file to attach to the audit log.
set -uo pipefail

BASE=${1:-https://shitgowhere.com}
BASE=${BASE%/}
HOST=${BASE#*://}
PAUSE=${PAUSE:-4}           # seconds between requests (keep it polite: ~15 requests a minute)
UA='sgw-ops-probe/1 (read-only)'
SHOW='strict-transport-security|content-security-policy|content-security-policy-report-only|x-content-type-options|x-frame-options|referrer-policy|permissions-policy|cross-origin-opener-policy|cross-origin-resource-policy|cache-control|content-type|content-length|server|x-powered-by|x-vercel-cache|x-vercel-id|x-matched-path|age|location|server-timing|service-worker-allowed|set-cookie|x-ratelimit-limit|x-ratelimit-remaining|etag|link|access-control-allow-origin'

get() { # path -> prints status line + selected headers
  local path=$1
  echo
  echo "### GET \`$path\`"
  echo '```'
  curl -sS -A "$UA" --max-time 30 -o /dev/null -D - -w 'status=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s size=%{size_download}B http=%{http_version} tls=%{ssl_verify_result}\n' "$BASE$path" 2>&1 \
    | tr -d '\r' | grep -i -E "^(HTTP/|status=|curl:|($SHOW):)" | cut -c1-300
  echo '```'
  sleep "$PAUSE"
}

echo "# Production probe: $BASE"
echo "_$(date -u +%Y-%m-%dT%H:%M:%SZ)_"

echo
echo "## Headers per route"
for p in / /go /sw.js /manifest.webmanifest /robots.txt /sitemap.xml /api/health /api/openapi.json /api/docs /api/toilets/nearby?lat=1.2993\&lng=103.8455 /toilets/does-not-exist /nonexistent-page; do
  get "$p"
done

echo
echo "## Static assets (immutable caching expected)"
html=$(curl -sS -A "$UA" --max-time 30 "$BASE/" || true)
sleep "$PAUSE"
asset=$(printf '%s' "$html" | grep -o '/_next/static/[^"]*\.\(js\|css\)' | head -1)
if [ -n "$asset" ]; then get "$asset"; else echo "(no /_next/static asset found in the HTML)"; fi

echo
echo "## Redirects and TLS"
echo '```'
echo "http://$HOST/ ->"
curl -sS -A "$UA" --max-time 20 -o /dev/null -D - -w 'status=%{http_code} redirect=%{redirect_url}\n' "http://$HOST/" 2>&1 | tr -d '\r' | grep -i -E '^(HTTP/|status=|location:|strict-transport|curl:)'
sleep "$PAUSE"
case "$HOST" in
  www.*) other=${HOST#www.} ;;
  *) other=www.$HOST ;;
esac
echo; echo "https://$other/ ->"
curl -sS -A "$UA" --max-time 20 -o /dev/null -D - -w 'status=%{http_code} redirect=%{redirect_url}\n' "https://$other/" 2>&1 | tr -d '\r' | grep -i -E '^(HTTP/|status=|location:|strict-transport|curl:)'
sleep "$PAUSE"
echo; echo "TLS:"
curl -sS -A "$UA" --max-time 20 -o /dev/null -w 'http=%{http_version} ssl_verify=%{ssl_verify_result} remote=%{remote_ip}\n' "$BASE/" 2>&1
if command -v openssl >/dev/null 2>&1; then
  echo | openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null | openssl x509 -noout -issuer -subject -dates 2>/dev/null
  for v in tls1 tls1_1; do
    if echo | openssl s_client -connect "$HOST:443" -servername "$HOST" "-$v" >/dev/null 2>&1; then echo "WARNING: $v accepted"; else echo "$v refused (good)"; fi
  done
fi
echo '```'

timing() { # label url n
  local label=$1 url=$2 n=$3 i
  echo
  echo "### $label ($n requests, ${PAUSE}s apart)"
  echo '```'
  local times=()
  for i in $(seq 1 "$n"); do
    out=$(curl -sS -A "$UA" --max-time 30 -o /dev/null -D /tmp/.sgw-probe-h -w '%{http_code} ttfb=%{time_starttransfer} total=%{time_total}' "$url" 2>&1)
    cache=$(tr -d '\r' < /tmp/.sgw-probe-h | grep -i -E '^x-vercel-cache:' | head -1)
    echo "$i: $out ${cache:-}"
    times+=("$(printf '%s' "$out" | sed -n 's/.*total=\([0-9.]*\).*/\1/p')")
    sleep "$PAUSE"
  done
  printf '%s\n' "${times[@]}" | sort -n | awk '{a[NR]=$1} END {printf "min=%.3fs median=%.3fs max=%.3fs (spread %.1fx)\n", a[1], a[int((NR+1)/2)], a[NR], (a[1]>0? a[NR]/a[1] : 0)}'
  echo '```'
  rm -f /tmp/.sgw-probe-h
}

echo
echo "## Timing spread (first request after a quiet period is the cold start)"
timing "/api/health" "$BASE/api/health" 6
timing "/api/toilets/nearby" "$BASE/api/toilets/nearby?lat=1.2993&lng=103.8455" 6

echo
echo "## Rendered HTML facts (compare with the code)"
echo '```'
printf '%s' "$html" | grep -o '<meta[^>]*\(og:image\|viewport\|theme-color\|apple-mobile\)[^>]*>' | head -8
printf '%s' "$html" | grep -o '<link[^>]*\(manifest\|canonical\|apple-touch-icon\)[^>]*>' | head -5
echo '```'
echo
echo "Service worker build id:"
echo '```'
curl -sS -A "$UA" --max-time 30 "$BASE/sw.js" | grep -m1 -E '^const BUILD' ; sleep "$PAUSE"
echo '```'

if [ -n "${LOCAL:-}" ]; then
  echo
  echo "## Diff against $LOCAL (manifest, robots)"
  for p in /manifest.webmanifest /robots.txt; do
    echo "### $p"; echo '```diff'
    diff <(curl -sS -A "$UA" "$BASE$p" | sed "s#$HOST#HOST#g") <(curl -sS "$LOCAL$p" | sed "s#${LOCAL#*://}#HOST#g") && echo "(identical)"
    echo '```'
    sleep "$PAUSE"
  done
fi
