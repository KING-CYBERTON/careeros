#!/usr/bin/env bash
# CAREEROS: P6-C01. Runs ON the production server (via the self-hosted runner). A copy of infra/staging/deploy.sh with
# the production project name and compose file, plus preflight.sh before anything starts.
# Does NOT record the tag as good; call mark-good.sh after verification.
# Usage: [GHCR_USER=<user>] [IMAGE_REPOSITORY=ghcr.io/<owner>/<repo>] echo "$TOKEN" | ./deploy.sh <image-tag>
# <image-tag> is a release version (1.2.3, 1.2.3-rc.1) or sha-<commit>. The GHCR read token (if any) is read from
# stdin and never echoed. Exits non-zero if preflight refuses the .env or the app is unhealthy.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

TAG="${1:?usage: deploy.sh <image-tag>}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"
COMPOSE=(docker compose -p careeros_production -f compose.production.yml)

if [[ ! -f .env ]]; then
	echo "deploy: .env is missing in $(pwd); create it from .env.production.example (see README.md)." >&2
	exit 1
fi

./preflight.sh .env

if [[ -z "${IMAGE_REPOSITORY:-}" ]]; then
	IMAGE_REPOSITORY="$(sed -n 's/^IMAGE_REPOSITORY=//p' .env | tail -n 1 | tr -d "\"'")"
fi
: "${IMAGE_REPOSITORY:?IMAGE_REPOSITORY is not set (env or .env)}"
export IMAGE_REPOSITORY
export IMAGE_TAG="$TAG"

# Release versions and sha-* images are published once and never moved, so an image already present locally needs no
# pull (and no registry login). This is what lets rollback.sh work without a token.
need_pull=true
if [[ "$TAG" =~ ^(sha-[0-9a-f]{40}|[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]] &&
	docker image inspect "$IMAGE_REPOSITORY:$TAG" >/dev/null 2>&1; then
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
