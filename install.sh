#!/usr/bin/env sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' >/dev/null 2>&1; then
  echo "错误：需要 Node.js 20 或以上版本。" >&2
  exit 1
fi

if [ $# -eq 0 ]; then
  exec node cli.cjs install --interactive --banner
fi

case "${1%/}" in
  -*) ;;
  *.AppImage|*.app) set -- install "$@" ;;
esac
exec node cli.cjs "$@"
