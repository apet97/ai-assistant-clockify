#!/usr/bin/env bash
#
# dev-tunnel.sh — manage the "temporary" Cloudflare quick tunnel + the dev server
# as ONE unit, so a dropped tunnel is a single-command resync instead of the
# manual BASE_URL dance.
#
# IMPORTANT: a Cloudflare *quick* tunnel gets a RANDOM https://<words>.trycloudflare.com
# URL every time `cloudflared` starts. It stays fixed for the LIFE of that process,
# so the win here is: keep it running, and when it does rotate, resync everything
# automatically (write BASE_URL into .env.server, restart the server) and tell you
# the one manual step left — re-register the manifest URL in the dev console. For a
# URL that NEVER changes you need the named-tunnel-on-a-domain route (see CLAUDE.md).
#
# Usage:
#   scripts/dev-tunnel.sh up        # ensure tunnel+server up; sync BASE_URL; print URL
#   scripts/dev-tunnel.sh status    # show tunnel URL, BASE_URL, server health
#   scripts/dev-tunnel.sh url       # print the current tunnel URL only
#   scripts/dev-tunnel.sh sync      # re-read the live URL -> BASE_URL -> restart server
#                                   #   (use when the tunnel is up but BASE_URL is stale)
#   scripts/dev-tunnel.sh restart   # rotate the tunnel (NEW url) + resync
#   scripts/dev-tunnel.sh down      # stop tunnel + server
#
# Overridable via env (used by the self-test): AIASSIST_PORT, AIASSIST_ENV_FILE,
# AIASSIST_TUNNEL_LOG, AIASSIST_TUNNEL_PID, AIASSIST_SERVER_LOG, AIASSIST_SERVER_PID.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${AIASSIST_PORT:-3001}"
ENV_FILE="${AIASSIST_ENV_FILE:-$ROOT/.env.server}"
TUNNEL_LOG="${AIASSIST_TUNNEL_LOG:-/tmp/aiassist-tunnel.log}"
TUNNEL_PID="${AIASSIST_TUNNEL_PID:-/tmp/aiassist-tunnel.pid}"
SERVER_LOG="${AIASSIST_SERVER_LOG:-/tmp/aiassist-server.log}"
SERVER_PID="${AIASSIST_SERVER_PID:-/tmp/aiassist-server.pid}"

log()  { printf '\033[36m[dev-tunnel]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[dev-tunnel]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[dev-tunnel]\033[0m %s\n' "$*" >&2; exit 1; }

# Extract the most recent trycloudflare.com URL from a log file (empty if none).
extract_url() {
  local file="$1"
  [ -f "$file" ] || { echo ""; return 0; }
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$file" 2>/dev/null | tail -1 || echo ""
}

# Upsert BASE_URL=<value> in an env file, preserving every other line.
set_base_url() {
  local value="$1" file="$2"
  [ -f "$file" ] || die "env file not found: $file"
  if grep -qE '^BASE_URL=' "$file"; then
    # Use a temp file so we never partially write the secret-bearing env file.
    awk -v v="$value" 'BEGIN{done=0} /^BASE_URL=/{print "BASE_URL=" v; done=1; next} {print} END{if(!done)print "BASE_URL=" v}' "$file" > "$file.tmp"
    mv "$file.tmp" "$file"
  else
    printf 'BASE_URL=%s\n' "$value" >> "$file"
  fi
}

pid_alive() { local f="$1"; [ -f "$f" ] && kill -0 "$(cat "$f" 2>/dev/null)" 2>/dev/null; }

start_tunnel() {
  if pid_alive "$TUNNEL_PID"; then
    log "tunnel already running (pid $(cat "$TUNNEL_PID"))"
    return 0
  fi
  : > "$TUNNEL_LOG"
  nohup cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
  echo $! > "$TUNNEL_PID"
  log "started cloudflared (pid $(cat "$TUNNEL_PID")); waiting for the URL…"
  local url="" i
  for i in $(seq 1 30); do
    url="$(extract_url "$TUNNEL_LOG")"
    [ -n "$url" ] && break
    sleep 1
  done
  [ -n "$url" ] || die "timed out waiting for the trycloudflare URL (see $TUNNEL_LOG)"
  log "tunnel URL: $url"
}

stop_tunnel() {
  if pid_alive "$TUNNEL_PID"; then kill "$(cat "$TUNNEL_PID")" 2>/dev/null || true; fi
  rm -f "$TUNNEL_PID"
  # Belt-and-suspenders: any stray quick tunnel for this local port.
  pkill -f "cloudflared tunnel --url http://localhost:$PORT" 2>/dev/null || true
}

start_server() {
  # Free the port first so the freshest BASE_URL is the one in effect.
  stop_server
  : > "$SERVER_LOG"
  ( cd "$ROOT" && nohup npx tsx --env-file="$ENV_FILE" src/server.ts > "$SERVER_LOG" 2>&1 & echo $! > "$SERVER_PID" )
  log "started server (pid $(cat "$SERVER_PID")) on :$PORT"
  local i
  for i in $(seq 1 20); do
    if curl -fsS -o /dev/null "http://localhost:$PORT/manifest" 2>/dev/null; then
      log "server healthy on :$PORT"
      return 0
    fi
    sleep 1
  done
  warn "server did not report healthy within 20s (see $SERVER_LOG)"
}

stop_server() {
  if pid_alive "$SERVER_PID"; then kill "$(cat "$SERVER_PID")" 2>/dev/null || true; fi
  rm -f "$SERVER_PID"
  # Adopt any unmanaged server already bound to the port.
  local held; held="$(lsof -ti:"$PORT" 2>/dev/null || true)"
  [ -n "$held" ] && kill $held 2>/dev/null || true
  return 0
}

print_register_hint() {
  local url="$1"
  cat <<EOF

  Public URL : $url
  Manifest   : $url/manifest

  Dev console: open developer.clockify.me workspace settings -> Add-ons, paste
               $url/manifest into "Insert link" and INSTALL (re-install if the URL
               changed — Clockify pins the component baseUrl at install time).
EOF
}

cmd_up() {
  start_tunnel
  local url; url="$(extract_url "$TUNNEL_LOG")"
  [ -n "$url" ] || die "no tunnel URL available"
  local current; current="$(grep -E '^BASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  if [ "$current" != "$url" ]; then
    log "BASE_URL changed: ${current:-<unset>} -> $url"
    set_base_url "$url" "$ENV_FILE"
    start_server
  else
    log "BASE_URL already matches the tunnel URL"
    pid_alive "$SERVER_PID" || lsof -ti:"$PORT" >/dev/null 2>&1 || start_server
  fi
  print_register_hint "$url"
}

cmd_sync() {
  pid_alive "$TUNNEL_PID" || die "no managed tunnel running; use 'up'"
  local url; url="$(extract_url "$TUNNEL_LOG")"
  [ -n "$url" ] || die "no tunnel URL in $TUNNEL_LOG"
  set_base_url "$url" "$ENV_FILE"
  start_server
  print_register_hint "$url"
}

cmd_status() {
  local url; url="$(extract_url "$TUNNEL_LOG")"
  local base; base="$(grep -E '^BASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  echo "tunnel pid   : $(pid_alive "$TUNNEL_PID" && cat "$TUNNEL_PID" || echo 'not running (managed)')"
  echo "tunnel URL   : ${url:-<none in log>}"
  echo "BASE_URL     : ${base:-<unset>}"
  echo "BASE matches : $([ -n "$url" ] && [ "$url" = "$base" ] && echo yes || echo 'NO — run: sync')"
  if curl -fsS -o /dev/null "http://localhost:$PORT/manifest" 2>/dev/null; then
    echo "server :$PORT : healthy"
  else
    echo "server :$PORT : DOWN"
  fi
}

cmd_url()     { extract_url "$TUNNEL_LOG"; }
cmd_down()    { stop_server; stop_tunnel; log "stopped tunnel + server"; }
cmd_restart() { stop_tunnel; cmd_up; }

main() {
  command -v cloudflared >/dev/null || die "cloudflared not found (brew install cloudflared)"
  case "${1:-up}" in
    up)      cmd_up ;;
    sync)    cmd_sync ;;
    status)  cmd_status ;;
    url)     cmd_url ;;
    down)    cmd_down ;;
    restart) cmd_restart ;;
    *)       die "unknown command: ${1:-}. Use: up|sync|status|url|down|restart" ;;
  esac
}

# Guard so the self-test can `source` this file and call functions directly.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
