#!/usr/bin/env bash
# CAREEROS: P0-C03. Runs ON the staging server.
# Usage: ./rollback.sh               redeploy the previous healthy tag (.previous_tag), e.g. manual rollback
#        ./rollback.sh --last-good   redeploy the last healthy tag (.current_tag); used by the workflow after a failed deploy
# Local sha-* images are reused, so no registry login is needed in the normal case.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

mode="${1:-previous}"
case "$mode" in
--last-good) file=".current_tag" ;;
previous) file=".previous_tag" ;;
*)
	echo "usage: rollback.sh [--last-good]" >&2
	exit 2
	;;
esac

if [[ ! -s "$file" ]]; then
	echo "rollback: no $file recorded; nothing to roll back to." >&2
	[[ "$mode" == "--last-good" ]] && exit 0
	exit 1
fi

tag="$(cat "$file")"
echo "rollback: redeploying $tag"
./deploy.sh "$tag"
if [[ "$mode" != "--last-good" ]]; then
	./mark-good.sh "$tag"
fi
