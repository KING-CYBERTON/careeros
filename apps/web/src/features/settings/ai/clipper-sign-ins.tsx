import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@reactive-resume/ui/components/button";
import { SettingsSection } from "../section";
import { getReadableErrorMessage } from "@/libs/error-message";
import { client } from "@/libs/orpc/client";

// CAREEROS (P5-T02): the member's Job Clipper sign-ins, each revocable. The mobile app lists the same rows
// (apps/mobile/src/features/settings/clipper-sign-ins.tsx).

const queryKey = ["clipper", "tokens"];

const shortDate = (value: string) =>
	new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export function ClipperSignInsSection() {
	const queryClient = useQueryClient();
	const {
		data: tokens = [],
		isPending,
		error,
	} = useQuery({
		queryKey,
		queryFn: () => client.clipper.listTokens(),
	});
	const revoke = useMutation({
		mutationFn: (id: string) => client.clipper.revokeToken({ id }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey }),
	});

	return (
		<SettingsSection
			title={<Trans>Job Clipper sign-ins</Trans>}
			description={
				<Trans>
					Browsers where you signed in to the Job Clipper extension. Revoke one and it stops working on its next
					request.
				</Trans>
			}
		>
			{error ? <p role="alert">{getReadableErrorMessage(error, t`Couldn't load your Job Clipper sign-ins.`)}</p> : null}
			{revoke.error ? (
				<p role="alert">{getReadableErrorMessage(revoke.error, t`Couldn't revoke this sign-in. Try again.`)}</p>
			) : null}
			{isPending ? (
				<p role="status">
					<Trans>Loading sign-ins...</Trans>
				</p>
			) : tokens.length === 0 ? (
				<p className="text-sm text-ink-3">
					<Trans>No Job Clipper sign-ins yet.</Trans>
				</p>
			) : (
				<ul className="divide-y divide-line">
					{tokens.map((token) => (
						<li key={token.id} className="flex items-center justify-between gap-3 py-3">
							<div className="min-w-0 text-sm">
								<p className="font-medium break-words">{token.organizationName}</p>
								<p className="break-words text-ink-3">{token.label}</p>
								<p className="text-xs text-ink-3">
									<Trans>Signed in</Trans> {shortDate(token.createdAt)} · <Trans>Last used</Trans>{" "}
									{token.lastUsedAt ? shortDate(token.lastUsedAt) : <Trans>Never</Trans>}
								</p>
							</div>
							<Button
								variant="secondary"
								size="sm"
								disabled={revoke.isPending}
								aria-label={t`Revoke the Job Clipper sign-in on ${token.label} for ${token.organizationName}`}
								onClick={() => revoke.mutate(token.id)}
							>
								<Trans>Revoke</Trans>
							</Button>
						</li>
					))}
				</ul>
			)}
		</SettingsSection>
	);
}
