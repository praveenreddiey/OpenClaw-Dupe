#!/bin/sh
set -eu

if [ -d /app/workspace ]; then
  mkdir -p /app/workspace/node_modules

  if [ ! -x /app/workspace/node_modules/.bin/tsc ]; then
    cp -a /app/node_modules/. /app/workspace/node_modules/
  fi
fi

exec "$@"
