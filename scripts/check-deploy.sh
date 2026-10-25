#!/usr/bin/env bash
# Diagnose a deployment: does /api reach the dashboard API, or is the platform
# answering instead?
#
#   scripts/check-deploy.sh https://dbremote.vercel.app
#
# Exits non-zero on the first failure so it can gate a deploy or CI job. The
# distinction it makes is the one that matters: a working deployment answers
# every /api path with JSON, and a broken one answers with an HTML error page
# because the API function was never built (Vercel Root Directory not the repo
# root, or `api/[...path].ts` excluded from the build).
set -u

BASE="${1:?usage: check-deploy.sh <base-url>}"
BASE="${BASE%/}"
fail=0

probe() {
  local path="$1" expect="$2" want="${3:-json}"
  local body status type
  body="$(curl -sS -m 15 -o /tmp/dbh-probe.$$ -w '%{http_code} %{content_type}' "$BASE$path" 2>/dev/null)"
  status="${body%% *}"
  type="${body#* }"
  local head; head="$(head -c 120 /tmp/dbh-probe.$$ 2>/dev/null)"
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
      printf 'ok   %-24s %s %s\n' "$path" "$status" "$head" ;;
    *)
      printf 'FAIL %-24s %s but content-type is %s (platform page, not the API)\n' "$path" "$status" "${type:-none}"
      printf '     first bytes: %s\n' "$head"
      fail=1 ;;
  esac
}

echo "Checking $BASE"
probe /api/healthz 200
probe /api/providers 200
probe /api/connections/status 200
probe /api/data/tables 401
probe / 200 html

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
