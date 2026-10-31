#!/usr/bin/env bash
# CAREEROS: P1-C01. Runs infra/db/bootstrap-roles.sql as a superuser (idempotent).
# Usage: SUPERUSER_URL=postgresql://postgres:...@host:5432/db \
#        CAREEROS_OWNER_PASSWORD=... CAREEROS_APP_PASSWORD=... infra/db/bootstrap-roles.sh
# Passwords travel only through PGOPTIONS (session settings) and are never echoed.
set -euo pipefail

: "${SUPERUSER_URL:?SUPERUSER_URL is not set}"
: "${CAREEROS_OWNER_PASSWORD:?CAREEROS_OWNER_PASSWORD is not set}"
: "${CAREEROS_APP_PASSWORD:?CAREEROS_APP_PASSWORD is not set}"

# PGOPTIONS splits on spaces and treats backslash as an escape; reject values that would break or inject options.
for value in "$CAREEROS_OWNER_PASSWORD" "$CAREEROS_APP_PASSWORD"; do
	if [[ "$value" =~ [[:space:]\\] ]]; then
		echo "bootstrap-roles: passwords must not contain whitespace or backslashes." >&2
		exit 1
	fi
done

sql_file="$(dirname "${BASH_SOURCE[0]}")/bootstrap-roles.sql"

PGOPTIONS="-c careeros.owner_password=${CAREEROS_OWNER_PASSWORD} -c careeros.app_password=${CAREEROS_APP_PASSWORD}" \
	psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 --quiet --file "$sql_file"

echo "bootstrap-roles: careeros_owner and careeros_app are ready."
