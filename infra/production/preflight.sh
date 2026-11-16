#!/usr/bin/env bash
# CAREEROS: P6-C01. Runs ON the production server before every deploy (deploy.sh calls it).
# Usage: ./preflight.sh [path to .env]   (default: .env next to this script)
# Refuses an .env that would switch on a test or unsafe setting in production. Prints the setting names, never values.
# Self-test: tooling/careeros/production-preflight.test.mjs.
set -euo pipefail

env_file="${1:-$(dirname "${BASH_SOURCE[0]}")/.env}"

if [[ ! -f "$env_file" ]]; then
	echo "preflight: $env_file is missing." >&2
	exit 1
fi

# Compose reads the file top to bottom and the last assignment of a name wins, so keep the last value of each name.
declare -A values=()
while IFS= read -r line || [[ -n "$line" ]]; do
	line="${line%$'\r'}"
	[[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
	name="${BASH_REMATCH[2]}"
	value="${BASH_REMATCH[3]}"
	# Trim spaces, then one pair of matching quotes.
	value="${value#"${value%%[![:space:]]*}"}"
	value="${value%"${value##*[![:space:]]}"}"
	if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
		value="${BASH_REMATCH[1]}"
	fi
	values["$name"]="$value"
done <"$env_file"

# The server parses flags with zod stringbool: these spellings mean true (any case).
is_true() {
	case "${1,,}" in
	true | 1 | yes | on | y | enabled) return 0 ;;
	*) return 1 ;;
	esac
}

problems=()
for name in "${!values[@]}"; do
	value="${values[$name]}"
	case "$name" in
	PAYSTACK_ALLOW_TEST_KEY | FLAG_DISABLE_API_RATE_LIMIT | FLAG_ALLOW_FAKE_BILLING | FLAG_ALLOW_UNSAFE_*)
		if is_true "$value"; then problems+=("$name must not be true in production"); fi
		;;
	PAYSTACK_SECRET_KEY)
		if [[ "$value" == sk_test_* ]]; then problems+=("PAYSTACK_SECRET_KEY is a Paystack test key (sk_test_)"); fi
		;;
	PAYSTACK_PUBLIC_KEY)
		if [[ "$value" == pk_test_* ]]; then problems+=("PAYSTACK_PUBLIC_KEY is a Paystack test key (pk_test_)"); fi
		;;
	BILLING_PROVIDER)
		if [[ "${value,,}" == fake ]]; then problems+=("BILLING_PROVIDER=fake is for tests only"); fi
		;;
	esac
done

if ((${#problems[@]} > 0)); then
	echo "preflight: refusing to deploy with $env_file:" >&2
	printf '%s\n' "${problems[@]}" | sort | sed 's/^/  - /' >&2
	exit 1
fi

if ! is_true "${values[STRICT_SCHEMA_CHECK]:-}"; then
	echo "preflight: warning: STRICT_SCHEMA_CHECK is not true; production should set STRICT_SCHEMA_CHECK=\"true\"." >&2
fi

echo "preflight: $env_file passed."
