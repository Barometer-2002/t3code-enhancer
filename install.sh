#!/usr/bin/env sh
set -eu
base="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
cd "$base"
if [ "$#" -eq 0 ]; then
  exec node cli.cjs install --interactive --banner
fi
exec node cli.cjs "$@"
