#!/usr/bin/env bash
# Creates .env from .env.example with freshly generated local secrets.
# You still have to paste DISCORD_WEBHOOK_URL into .env yourself.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -e .env ]; then
  echo ".env already exists, leaving it untouched." >&2
  exit 1
fi

token="$(openssl rand -hex 24)"
db_password="$(openssl rand -hex 16)"

sed \
  -e "s|^WEBHOOK_TOKEN=.*|WEBHOOK_TOKEN=${token}|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${db_password}|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://research_trade:${db_password}@127.0.0.1:5432/research_trade|" \
  .env.example > .env
chmod 600 .env

echo "Created .env with a random WEBHOOK_TOKEN and database password."
echo "Next: set DISCORD_WEBHOOK_URL in .env, then run: docker compose up -d postgres"
