#!/usr/bin/env bash
# Rehearses a Render deploy of the backend on Linux before anything reaches
# production. In a fresh node container it does what Render's build does
# (`npm ci --include=dev`, which builds dist/), loads schema.sql into the
# docker-compose.test.yml database, then runs `npm run agent:preflight`. Pass
# --live to also run one fictional Pocky turn, which proves the runtime
# reaches DeepSeek from Linux.
#
#   docker compose -f docker-compose.test.yml up -d --wait
#   backend/scripts/rehearse-linux.sh            # preflight only
#   backend/scripts/rehearse-linux.sh --live     # plus one model turn
#
# The container runs this machine's own architecture by default. Render is
# linux/amd64; on an Apple-silicon Mac that platform runs under QEMU, which is
# slow. Set REHEARSAL_PLATFORM=linux/amd64 on an x64 machine; on Render itself,
# run `npm run agent:preflight` in the Shell to cover the real CPU.
#
# Secrets: the source is streamed into the container with every .env file left
# out, so no dependency's install script can read DATABASE_URL (in the main
# checkout that is production). --live takes DEEPSEEK_API_KEY from the
# environment, or from that one line of backend/.env; it reaches the container
# by name only (never on a command line) and is withheld from `npm ci`.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
node_version=$(tr -d '[:space:]' < "$root/backend/.node-version")
network=termpocket-test_default
platform=${REHEARSAL_PLATFORM:-linux/$(docker version --format '{{.Server.Arch}}')}

if ! docker network inspect "$network" >/dev/null 2>&1; then
  echo "Start the test database first: docker compose -f docker-compose.test.yml up -d --wait" >&2
  exit 1
fi

key_args=()
if [[ " $* " == *" --live "* ]]; then
  if [[ -z "${DEEPSEEK_API_KEY:-}" && -f "$root/backend/.env" ]]; then
    # Accepts an `export ` prefix, surrounding quotes and a CRLF line ending.
    DEEPSEEK_API_KEY=$(sed -nE 's/^(export[[:space:]]+)?DEEPSEEK_API_KEY=//p' "$root/backend/.env" | head -n 1 | tr -d '\r')
    DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY#[\"\']}
    DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY%[\"\']}
  fi
  if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
    echo "--live needs DEEPSEEK_API_KEY in the environment or backend/.env" >&2
    exit 1
  fi
  export DEEPSEEK_API_KEY
  key_args=(-e DEEPSEEK_API_KEY)
fi

echo "Rehearsing on $platform with Node $node_version" >&2
tar -C "$root/backend" --exclude=./node_modules --exclude=./dist --exclude='./.env*' -cf - . |
docker run --rm -i --platform "$platform" --network "$network" \
  -e NODE_ENV=production \
  -e DATABASE_URL=postgresql://postgres@postgres:5432/termpocket_test \
  -e JWT_SECRET=linux-rehearsal-only-not-a-real-secret \
  -e AGENT_ENABLED=true \
  ${key_args[@]+"${key_args[@]}"} \
  "node:${node_version}-bookworm-slim" \
  bash -euo pipefail -c '
    mkdir /app && tar -C /app -xf - && cd /app
    key=${DEEPSEEK_API_KEY-}
    unset DEEPSEEK_API_KEY
    npm ci --include=dev --no-audit --no-fund --loglevel=error
    node dist/db/setup.js
    DEEPSEEK_API_KEY=$key npm run --silent agent:preflight -- "$@"
  ' rehearse "$@"
