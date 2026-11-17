#!/usr/bin/env bash
# CAREEROS: P0-C03. Runs ON the staging server.
# Usage: ./mark-good.sh <image-tag>
# Records a fully verified tag: .current_tag = last verified tag, .previous_tag = the one before it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

TAG="${1:?usage: mark-good.sh <image-tag>}"

if [[ -s .current_tag ]]; then
	current="$(cat .current_tag)"
	if [[ "$current" != "$TAG" ]]; then
		printf '%s\n' "$current" >.previous_tag
	fi
fi
printf '%s\n' "$TAG" >.current_tag
echo "mark-good: $TAG recorded as the last verified tag."
