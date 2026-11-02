/** Explicit Android package intent bypasses disabled App Links, retaining the registered HTTPS OAuth response. */
export function androidCallbackIntent(search: string): string {
	// CAREEROS: careeros-branding-allow: native app host, release blocker until the native identity is set (Q80)
	const callback = new URL("https://rxresu.me/auth/native-callback");
	callback.search = search;
	return `intent://${callback.host}${callback.pathname}${callback.search}#Intent;scheme=https;package=me.rxresu;end`;
}
