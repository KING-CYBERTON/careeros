// CAREEROS (P2-T02): the server answers a host that has the shape of an organization address but no organization with
// the app shell, status 404 and `window.__ORG_NOT_FOUND__ = true` (apps/server/src/static/web.ts). The SPA then shows
// the "not set up yet" page instead of starting, since every API call on that host would answer 404.
export function isUnknownOrganization(): boolean {
	return (globalThis as { __ORG_NOT_FOUND__?: unknown }).__ORG_NOT_FOUND__ === true;
}
