#!/bin/sh
# The image's entrypoint. `serve` (the default) migrates the database, seals any content still in plaintext
# (pnpm encrypt-backfill: at once when there is none), creates the owner's head on first
# start if PBCP_OWNER is set (printing the enrolment link to the log; `pnpm seed` prints a new one), and
# starts the head. Anything else is run as given, e.g. `pnpm seed morten` or `pnpm test:gate`.
set -e
if [ "$1" = "serve" ]; then
  if [ "${#SESSION_SECRET}" -lt 32 ]; then echo 'SESSION_SECRET must be set to at least 32 characters (.env; openssl rand -base64 48)' >&2; exit 1; fi
  if [ -z "$CRON_SECRET" ]; then echo 'CRON_SECRET must be set (.env; openssl rand -base64 32)' >&2; exit 1; fi
  if [ -z "$HEAD_MASTER_KEY" ]; then echo 'HEAD_MASTER_KEY must be set (.env; openssl rand -base64 32). Keep a copy outside the host: card content is encrypted under it (docs/deploy.md "At rest")' >&2; exit 1; fi
  pnpm -s db:migrate
  pnpm -s encrypt-backfill
  if [ -n "$PBCP_OWNER" ]; then pnpm -s seed "$PBCP_OWNER" --if-new ${PBCP_TIMEZONE:+--timezone "$PBCP_TIMEZONE"}; fi
  exec pnpm -s start
fi
exec "$@"
