import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { fetchHandoffRequest } from "../handoff";
import { authClient } from "@/libs/auth/client";

// CAREEROS (P2-T05): the platform host's half of the sign-in handoff. An organization host sent the visitor here with a
// request id; the page starts the provider's sign-in with the issue endpoint as its callback, so the provider only ever
// sees the platform host's single registered redirect address.

type HandoffPageProps = { requestId: string };

export function HandoffPage({ requestId }: HandoffPageProps) {
	const navigate = useNavigate();
	const started = useRef(false);
	const [organizationName, setOrganizationName] = useState<string>();

	useEffect(() => {
		// React runs effects twice in development; the provider redirect must start once.
		if (started.current) return;
		started.current = true;
		const fail = () => void navigate({ to: "/auth/error", search: { error: "handoff_failed" }, replace: true });
		void (async () => {
			const request = await fetchHandoffRequest(requestId);
			if (!request) return fail();
			setOrganizationName(request.organizationName);
			// A relative callback: Better Auth sends the browser back to this host's issue endpoint after the provider.
			const { error } = await authClient.signIn.social({
				provider: request.provider,
				callbackURL: `/api/careeros/handoff/issue?request=${encodeURIComponent(requestId)}`,
			});
			if (error) fail();
		})();
	}, [navigate, requestId]);

	return (
		<div className="space-y-4 text-center">
			<h1 className="text-[30px] leading-9">
				{organizationName ? t`Signing in to ${organizationName}` : t`Signing you in`}
			</h1>
			<p className="text-muted-foreground text-sm">
				<Trans>You'll go to your sign-in provider next, then come back.</Trans>
			</p>
			{!organizationName && <Skeleton className="mx-auto h-4 w-40" />}
		</div>
	);
}
