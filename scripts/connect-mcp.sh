#!/usr/bin/env sh
set -eu

usage() {
  cat <<'USAGE'
Usage: scripts/connect-mcp.sh <codex|claude> <https://YOUR-WORKER.workers.dev/mcp> [name]

Registers a remote Arra Memory MCP server, then starts OAuth where supported.
The Worker URL is public; do not pass database tokens or owner passphrases here.
USAGE
}

if [ "${1:-}" = "--help" ] || [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  usage
  [ "${1:-}" = "--help" ] && exit 0
  exit 64
fi

client=$1
url=$2
name=${3:-arra-memory}

case "$url" in
  https://*/mcp) ;;
  *) echo "MCP URL must be an HTTPS URL ending in /mcp" >&2; exit 64 ;;
esac

case "$client" in
  codex)
    codex mcp add "$name" --url "$url"
    codex mcp login "$name"
    ;;
  claude)
    claude mcp add --transport http --scope user "$name" "$url"
    claude mcp login "$name"
    ;;
  *) usage; exit 64 ;;
esac
