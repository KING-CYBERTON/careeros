import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { formatDate, notify } from "./shared";
import { authClient } from "@/libs/auth/client";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

/**
 * CAREEROS (P3-T07, requirement 3): shown on every page of a support (impersonation) session, to the member whose
 * account it is. It says that a platform administrator is signed in as them, until when, and lets them end it at once.
 * It renders only for a session the server marked as impersonated, and asks the server for the details; it is not the
 * guard (the server refuses an impersonated session without a live record on every request).
 */
export function ImpersonationBanner() {
	const { session, flags } = useRouteContext({ strict: false });
	const impersonated = Boolean((session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy);
	const query = useQuery({
		...orpc.impersonation.current.queryOptions(),
		enabled: impersonated,
		refetchInterval: 60_000,
	});
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!impersonated) return;
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [impersonated]);

	const end = useMutation(
		orpc.impersonation.end.mutationOptions({
			onSuccess: async () => {
				// The session record is ended; also drop the browser session and leave for the platform host.
				await authClient.signOut().catch(() => undefined);
				window.location.assign(flags?.appUrl ?? "/");
			},
			onError: (error: unknown) =>
				notify.error(getReadableErrorMessage(error, t`The support session could not be ended.`)),
		}),
	);

	if (!impersonated) return null;
	const expiresAt = query.data?.expiresAt;
	const minutes = expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - now) / 60_000)) : null;

	return (
		<div
			role="status"
			data-testid="impersonation-banner"
			className="sticky top-0 z-50 flex w-full flex-wrap items-center gap-x-3 gap-y-1 bg-danger px-4 py-2 text-[13px] leading-[19px] text-white"
		>
			<Icon name="warning-circle" size={18} className="shrink-0" />
			<p className="min-w-0 flex-1">
				<Trans>A platform administrator is signed in as you for support.</Trans>{" "}
				{expiresAt && (
					<span>
						<Trans>It ends at {formatDate(expiresAt)}</Trans>
						{minutes !== null && ` (${minutes} min)`}.
					</span>
				)}
			</p>
			<Button size="sm" variant="secondary" loading={end.isPending} onClick={() => end.mutate({})}>
				<Trans>End now</Trans>
			</Button>
		</div>
	);
}
