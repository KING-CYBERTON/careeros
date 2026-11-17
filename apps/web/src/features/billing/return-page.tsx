import type { BillingSnapshot } from "./lib";
import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Spinner } from "@reactive-resume/ui/components/spinner";
import { CONFIRMATION_POLL_MS, CONFIRMATION_TIMEOUT_MS, paymentConfirmed } from "./lib";
import { useBilling } from "./queries";
import { PageHeader } from "@/components/layout/page-header";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T06): where the payment provider sends the customer back. The plan changes only when the provider's
// verified webhook arrives, so this page asks `billing.get` every few seconds, for at most 60 seconds, until it moves.

type ReturnState = "waiting" | "confirmed" | "slow" | "declined";

type BillingReturnProps = {
	/** The `billing` query value of the address: the fake provider sets `approved` or `declined`. */
	result?: string | undefined;
	pollMs?: number;
	timeoutMs?: number;
};

export function BillingReturn({
	result,
	pollMs = CONFIRMATION_POLL_MS,
	timeoutMs = CONFIRMATION_TIMEOUT_MS,
}: BillingReturnProps) {
	const queryClient = useQueryClient();
	const [timedOut, setTimedOut] = useState(false);
	const declined = result === "declined";
	const billing = useBilling({ enabled: !declined, refetchInterval: timedOut ? false : pollMs });
	// The state when the page opened, kept to tell when a payment moved it.
	const [first, setFirst] = useState<BillingSnapshot | null>(null);
	if (billing.data && first === null) setFirst(billing.data);

	useEffect(() => {
		const timer = setTimeout(() => setTimedOut(true), timeoutMs);
		return () => clearTimeout(timer);
	}, [timeoutMs]);

	const confirmed = billing.data && first ? paymentConfirmed(first, billing.data) : false;
	useEffect(() => {
		if (confirmed) void queryClient.invalidateQueries({ queryKey: orpc.organization.key() });
	}, [confirmed, queryClient]);

	const state: ReturnState = declined ? "declined" : confirmed ? "confirmed" : timedOut ? "slow" : "waiting";

	return (
		<div className="mx-auto grid w-full max-w-[640px] content-start gap-6 px-6 pt-8 pb-16 max-sm:px-4">
			<PageHeader title={<Trans>Payment</Trans>} />
			<div role="status" aria-live="polite" className="grid gap-3" data-testid="billing-return" data-state={state}>
				{state === "waiting" && (
					<p className="flex items-center gap-2 text-base">
						<Spinner />
						<Trans>Payment received, updating your plan</Trans>
					</p>
				)}
				{state === "confirmed" && (
					<p className="text-base">
						<Trans>Your plan is updated.</Trans>
					</p>
				)}
				{state === "slow" && (
					<p className="text-base">
						<Trans>
							Confirmation may take a few minutes. You can leave this page; your plan updates as soon as the payment is
							confirmed.
						</Trans>
					</p>
				)}
				{state === "declined" && (
					<p className="text-base">
						<Trans>The payment was not completed. Nothing was charged and your plan has not changed.</Trans>
					</p>
				)}
			</div>
			<Button className="w-fit" render={<Link to="/dashboard/organization/billing" />}>
				<Trans>Back to billing</Trans>
			</Button>
		</div>
	);
}
