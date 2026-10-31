#!/usr/bin/env bash
# CAREEROS: P0-C03. Runs ON the staging server (via the self-hosted runner).
# Does NOT record the tag as good; call mark-good.sh after verification.
# Usage: [GHCR_USER=<user>] [IMAGE_REPOSITORY=ghcr.io/<owner>/<repo>] echo "$TOKEN" | ./deploy.sh <image-tag>
# The GHCR read token (if any) is read from stdin and never echoed. Exits non-zero if the app is unhealthy.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

TAG="${1:?usage: deploy.sh <image-tag>}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
COMPOSE=(docker compose -p careeros_staging -f compose.staging.yml)

if [[ ! -f .env ]]; then
	echo "deploy: .env is missing in $(pwd); create it from .env.staging.example (see README.md)." >&2
	exit 1
fi

if [[ -z "${IMAGE_REPOSITORY:-}" ]]; then
	IMAGE_REPOSITORY="$(sed -n 's/^IMAGE_REPOSITORY=//p' .env | tail -n 1 | tr -d "\"'")"
fi
: "${IMAGE_REPOSITORY:?IMAGE_REPOSITORY is not set (env or .env)}"
export IMAGE_REPOSITORY
export IMAGE_TAG="$TAG"

# Immutable sha-* images that are already present locally need no pull (and no registry login).
need_pull=true
if [[ "$TAG" == sha-* ]] && docker image inspect "$IMAGE_REPOSITORY:$TAG" >/dev/null 2>&1; then
	need_pull=false
fi

if [[ "$need_pull" == true ]]; then
	if [[ -n "${GHCR_USER:-}" ]]; then
		if [[ -t 0 ]]; then
			echo "deploy: GHCR_USER is set but no token on stdin." >&2
			exit 1
		fi
		docker login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null
	fi
	echo "deploy: pulling $IMAGE_REPOSITORY:$TAG"
	"${COMPOSE[@]}" pull app
fi

echo "deploy: starting stack with $IMAGE_REPOSITORY:$TAG"
"${COMPOSE[@]}" up -d --remove-orphans

app_status() {
	local cid
	cid="$("${COMPOSE[@]}" ps -q app)"
	if [[ -z "$cid" ]]; then
		echo "missing"
		return
	fi
	docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid"
}

deadline=$((SECONDS + HEALTH_TIMEOUT))
status="unknown"
while ((SECONDS < deadline)); do
	status="$(app_status)"
	if [[ "$status" == "healthy" ]]; then
		break
	fi
	sleep 5
done

if [[ "$status" != "healthy" ]]; then
	echo "deploy: app not healthy after ${HEALTH_TIMEOUT}s (status: $status). Recent logs:" >&2
	"${COMPOSE[@]}" logs --tail 50 app >&2 || true
	exit 1
fi

echo "deploy: $TAG is healthy. Run mark-good.sh $TAG once it is verified (health revision, smoke)."
