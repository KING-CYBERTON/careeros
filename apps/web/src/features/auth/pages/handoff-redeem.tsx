import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { captureRedeemFragment, redeemOrganizationHandoff } from "../handoff";

// CAREEROS (P2-T05): the organization host's half of the sign-in handoff. The one-time token arrives in the URL
// fragment, which never reaches a server log or a Referer header. It is read once, removed from the address bar, and
// exchanged with the browser-bound cookie for a session cookie on this host only.

export function HandoffRedeemPage() {
	const navigate = useNavigate();
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const fail = () => void navigate({ to: "/auth/error", search: { error: "handoff_failed" }, replace: true });
		void (async () => {
			const fragment = captureRedeemFragment();
			if (!fragment) return fail();
			const returnTo = await redeemOrganizationHandoff(fragment);
			if (!returnTo) return fail();
			// A full load, so the app starts with the new session.
			window.location.replace(returnTo);
		})();
	}, [navigate]);

	return (
		<div className="space-y-4 text-center">
			<h1 className="text-[30px] leading-9">{t`Signing you in`}</h1>
			<p className="text-muted-foreground text-sm">
				<Trans>One moment while we finish signing you in.</Trans>
			</p>
			<Skeleton className="mx-auto h-4 w-40" />
		</div>
	);
}
