import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";

// CAREEROS (P3-T07): the member host's half of a support session. The one-time token arrives in the URL fragment, which
// never reaches a server log or a Referer header. It is read once, removed from the address bar, and exchanged on this
// host for the support session's cookie. Reachable without a session.

export function ImpersonateRedeemPage() {
	const started = useRef(false);
	// The fragment is read once, when the page first renders; a link without it has already failed.
	const [fragment] = useState(() => {
		const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
		const id = params.get("id");
		const token = params.get("token");
		return id && token ? { id, token } : null;
	});
	const [failed, setFailed] = useState(fragment === null);

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		// Out of the address bar and the history entry at once, before anything else runs.
		window.history.replaceState(null, "", window.location.pathname);
		if (!fragment) return;
		const { id, token } = fragment;
		void (async () => {
			try {
				const response = await fetch("/api/careeros/impersonation/redeem", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id, token }),
				});
				if (!response.ok) return setFailed(true);
				const body: unknown = await response.json();
				const returnTo =
					body && typeof body === "object" && "returnTo" in body && typeof body.returnTo === "string"
						? body.returnTo
						: "/dashboard";
				// A full load, so the app starts with the support session.
				window.location.replace(returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/dashboard");
			} catch {
				setFailed(true);
			}
		})();
	}, [fragment]);

	if (failed)
		return (
			<div className="space-y-4 text-center" data-testid="impersonate-failed">
				<h1 className="text-[30px] leading-9">{t`This support link did not work`}</h1>
				<p className="text-muted-foreground text-sm">
					<Trans>The link has expired or was already used. Start the support session again from the console.</Trans>
				</p>
			</div>
		);

	return (
		<div className="space-y-4 text-center">
			<h1 className="text-[30px] leading-9">{t`Starting the support session`}</h1>
			<p className="text-muted-foreground text-sm">
				<Trans>One moment.</Trans>
			</p>
			<Skeleton className="mx-auto h-4 w-40" />
		</div>
	);
}
