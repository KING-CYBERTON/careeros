// CAREEROS (P2-T07): the plain words for a custom domain's status and failure, shared by the Domains screen and its tests.
import { t } from "@lingui/core/macro";

export type DomainStatus = "pending" | "verified" | "active" | "failed" | "removing";
export type BadgeTone = "warn" | "info" | "accent" | "danger" | "neutral";

export function statusInfo(status: DomainStatus): { label: string; tone: BadgeTone; hint: string } {
	switch (status) {
		case "pending":
			return {
				label: t`Waiting for DNS`,
				tone: "warn",
				hint: t`Create the two records below at your DNS provider. We check every few minutes.`,
			};
		case "verified":
			return {
				label: t`Issuing certificate`,
				tone: "info",
				hint: t`Ownership is proven. The certificate is being issued; this usually takes a few minutes.`,
			};
		case "active":
			return { label: t`Active`, tone: "accent", hint: t`Your organization is served on this domain.` };
		case "failed":
			return { label: t`Failed`, tone: "danger", hint: t`Remove the domain and add it again once the cause is fixed.` };
		case "removing":
			return {
				label: t`Removing`,
				tone: "neutral",
				hint: t`This domain no longer serves your organization and is being deleted.`,
			};
	}
}

/** What a failure code means, in plain words. Unknown codes get a generic line. */
export function failureText(reason: string | null): string | null {
	if (!reason) return null;
	switch (reason) {
		case "verification_timeout":
			return t`We didn't find the ownership record in time. Check that the TXT record exists exactly as shown.`;
		case "txt_missing":
			return t`The ownership TXT record is gone. Add it back, or remove the domain.`;
		case "cloudflare_rejected":
			return t`The certificate provider rejected this domain. Check that the CNAME record points where shown.`;
		case "cloudflare_moved":
			return t`The domain's certificate setup moved and can't be used. Remove the domain and add it again.`;
		case "cloudflare_deleted":
			return t`The domain was deleted at the certificate provider. Remove it and add it again.`;
		case "hostname_taken":
			return t`Another account claimed this domain first.`;
		default:
			return t`Something went wrong while checking this domain. Remove it and add it again.`;
	}
}

/** Seconds left until a manual recheck is allowed again (one a minute per domain), or 0. */
export function recheckWaitSeconds(lastCheckedAt: Date | string | null, now: number = Date.now()): number {
	if (!lastCheckedAt) return 0;
	const elapsed = now - new Date(lastCheckedAt).getTime();
	return Math.max(0, Math.ceil((60_000 - elapsed) / 1000));
}
