#!/usr/bin/env bash
# Diagnose a deployment: does /api reach the dashboard API, or is the platform
# answering instead?
#
#   scripts/check-deploy.sh https://dbremote.vercel.app           # probe a deployment
#   scripts/check-deploy.sh --api                                 # probe the API host ($API_ORIGIN)
#   scripts/check-deploy.sh --api https://api.example.com         # probe a specific API host
#
# Two surfaces are checked:
#
#   * Deployment mode (default) probes a public origin. A working deployment
#     answers every /api path with JSON and / with the SPA shell; an HTML page
#     on an /api path means the API function was never built (Vercel Root
#     Directory not the repo root, or `api/[...path].ts` excluded from the
#     build), or `API_ORIGIN` points back at the SPA.
#   * API mode probes the persistent API host directly. The Express server
#     registers *both* `/healthz` and `/api/healthz`
#     (packages/server/src/api/routes.ts), and a healthy API answers both with
#     {"ok":true}. Probing only one URL can miss a host that answers it through
#     the deployment proxy while the API itself is unreachable, so the API check
#     always curls both. When $API_ORIGIN is set (comma-separated ok),
#     deployment mode runs this API check too.
#
# Exits non-zero on the first failure so it can gate a deploy or CI job.
set -u

fail=0

usage() {
  cat >&2 <<'EOF'
usage: check-deploy.sh <base-url>      probe a deployment via its public URL
       check-deploy.sh --api [origin]  probe the API host (defaults to $API_ORIGIN)
EOF
  exit 2
}

probe() {
  local base="$1" path="$2" expect="$3" want="${4:-json}"
  local body status type head
  body="$(curl -sS -m 15 -o /tmp/dbh-probe.$$ -w '%{http_code} %{content_type}' "$base$path" 2>/dev/null)"
  status="${body%% *}"
  type="${body#* }"
  head="$(head -c 120 /tmp/dbh-probe.$$ 2>/dev/null)"
  rm -f /tmp/dbh-probe.$$

  if [ "$status" != "$expect" ]; then
    printf 'FAIL %-24s expected %s, got %s\n' "$path" "$expect" "$status"
    fail=1
    return
  fi
  if [ "$want" = "html" ]; then
    case "$type" in
      text/html*) printf 'ok   %-24s %s (SPA shell)\n' "$path" "$status" ;;
      *) printf 'FAIL %-24s expected the SPA shell, got content-type %s\n' "$path" "${type:-none}"; fail=1 ;;
    esac
    return
  fi

  case "$type" in
    application/json*)
      if [ "$want" = "healthz" ]; then
        if ! printf '%s' "$head" | grep -q '"ok"'; then
          printf 'FAIL %-24s %s but body has no {"ok":true}: %s\n' "$path" "$status" "$head"
          fail=1
          return
        fi
        printf 'ok   %-24s %s %s\n' "$path" "$status" "$head"
      else
        printf 'ok   %-24s %s %s\n' "$path" "$status" "$head"
      fi ;;
    *)
      printf 'FAIL %-24s %s but content-type is %s (platform page, not the API)\n' "$path" "$status" "${type:-none}"
      printf '     first bytes: %s\n' "$head"
      fail=1 ;;
  esac
}

# API-host check: curl the persistent API at both /api/healthz and /healthz.
# The Express server registers both routes, so an API that answers only one (or
# only answers through the deployment proxy) is called out instead of passing.
# `curl API_ORIGIN/api/healthz` must return 200 {"ok":true} — the 401 it used to
# return under AUTH_REQUIRED=true was the auth gate swallowing the public probe,
# fixed in packages/server/src/api/routes.ts.
check_api_host() {
  local origin="$1" base
  base="${origin%/}"
  echo "Checking API host $base"
  probe "$base" /api/healthz 200 healthz
  probe "$base" /healthz 200 healthz
}

# API mode probes the API host(s) and nothing else.
if [ "${1:-}" = "--api" ]; then
  ORIGIN="${2:-${API_ORIGIN:-}}"
  if [ -z "$ORIGIN" ]; then
    echo "error: --api needs an origin (pass one or set \$API_ORIGIN)" >&2
    usage
  fi
  for origin in ${ORIGIN//,/ }; do check_api_host "$origin"; done
  if [ "$fail" -ne 0 ]; then
    echo "API checks failed: a healthy API answers both /api/healthz and /healthz with {'ok':true}." >&2
    exit 1
  fi
  echo "All API checks passed."
  exit 0
fi

[ $# -gt 0 ] || usage

BASE="${1%/}"

echo "Checking $BASE"
probe "$BASE" /api/healthz 200 healthz
probe "$BASE" /api/providers 200
probe "$BASE" /api/connections/status 200
probe "$BASE" /api/data/tables 401
probe "$BASE" / 200 html

# Deployment mode also checks the API host(s) the deployment proxies to, so the
# API check runs even when curl'ing the deployment directly would only prove the
# proxy function is alive.
if [ -n "${API_ORIGIN:-}" ]; then
  for origin in ${API_ORIGIN//,/ }; do check_api_host "$origin"; done
fi

if [ "$fail" -ne 0 ]; then
  cat <<'EOF'

One or more checks failed. If /api/* returned an HTML page, the deployment is
not routing /api to the dashboard API. On Vercel that means:
  * Project Settings -> General -> Root Directory must be the repository root
    (empty), never packages/client, so `api/[...path].ts` is built.
  * Build Command: npm run build -w client
  * Output Directory: packages/client/dist
  * Environment: API_ORIGIN (and optionally API_ORIGIN_FALLBACK) must be set to
    the persistent API server URL, not to this deployment.
EOF
  exit 1
fi
echo "All checks passed."
