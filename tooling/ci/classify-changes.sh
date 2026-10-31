#!/usr/bin/env bash
# CAREEROS: P1-C05. Reads changed paths (one per line) on stdin and prints "code=true" or "code=false".
# code=false only when every path is documentation. An empty list, or any other path, means code=true.
# Docs-only paths:
#   docs/**  (except docs/applying-custom-styles.mdx, which tooling/custom-styles.test.ts reads)
#   **/*.md  (except under apps/, packages/, plugins/, tooling/, tests/, infra/ and .github/, which stay code)
#   .github/ISSUE_TEMPLATE/**
#   LICENSE, LICENSE.md, LICENSE.txt at the repository root (not a bare LICENSE* glob, which would match LICENSE.ts)
set -euo pipefail

is_docs_path() {
	local path="$1"
	case "$path" in
	docs/applying-custom-styles.mdx) return 1 ;;
	docs/*) return 0 ;;
	.github/ISSUE_TEMPLATE/*) return 0 ;;
	LICENSE | LICENSE.md | LICENSE.txt) return 0 ;;
	apps/* | packages/* | plugins/* | tooling/* | tests/* | infra/* | .github/*) return 1 ;;
	*.md) return 0 ;;
	*) return 1 ;;
	esac
}

seen=0
code=false
while IFS= read -r path || [ -n "$path" ]; do
	[ -z "$path" ] && continue
	seen=1
	if ! is_docs_path "$path"; then
		code=true
		break
	fi
done

if [ "$seen" -eq 0 ]; then code=true; fi
echo "code=$code"
