#!/bin/sh
# Vercel build for the pnpm monorepo (runs with Root Directory = packages/web-app).
# 1. Generate the Prisma client.
# 2. Production deployments only: apply pending migrations to Neon through the direct
#    (non-pooled) connection, because Prisma migrations need session-level advisory locks.
#    The connection string stays inside Vercel's encrypted environment.
# 3. Build the Next.js app.
set -eu

PNPM="npx -y pnpm@11.28.12"

$PNPM --filter @veriwork/database run db:generate

if [ "${VERCEL_ENV:-}" = "production" ]; then
  if [ -z "${DATABASE_URL_UNPOOLED:-}" ]; then
    echo "DATABASE_URL_UNPOOLED is not set; refusing to build production without migrations" >&2
    exit 1
  fi
  DATABASE_URL="$DATABASE_URL_UNPOOLED" $PNPM --filter @veriwork/database run db:migrate
fi

$PNPM --filter @veriwork/web-app run build
