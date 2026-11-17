import { Trans } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { Icon } from "@reactive-resume/ui/components/icon";

/**
 * CAREEROS (P3-T02, phase plan D3): a full-width strip on every dashboard page while the organization is suspended.
 * A suspended organization can sign in, view and export its data, but the server refuses every write (ORG_SUSPENDED).
 * The banner only explains why; it is not the guard.
 */
export function SuspendedBanner() {
	const { flags } = useRouteContext({ strict: false });
	if (!flags?.organization?.readOnly) return null;

	return (
		<div
			role="status"
			data-testid="suspended-banner"
			className="flex w-full items-center gap-2.5 bg-warn-soft px-4 py-2.5 text-[13px] leading-[19px] text-warn-text"
		>
			<Icon name="warning-circle" size={18} className="shrink-0" />
			<p>
				<Trans>This organization is suspended. You can view and export your data. Contact your administrator.</Trans>
			</p>
		</div>
	);
}

/** Whether writes are refused for the active organization (for screens that disable their own write action). */
export function useOrganizationReadOnly(): boolean {
	const { flags } = useRouteContext({ strict: false });
	return flags?.organization?.readOnly === true;
}
