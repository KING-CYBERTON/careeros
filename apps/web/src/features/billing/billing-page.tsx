import type { CheckoutChoice, PlanListing } from "./plans";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { BillingDetails } from "./billing-details";
import { methodSelectable, toCheckoutInput } from "./checkout-adapter";
import { InvoiceList } from "./invoices";
import { minimumSeats, seatProblem } from "./lib";
import { CheckoutForm, PlanCards } from "./plans";
import { useAiCredits, useBilling, useInvoices } from "./queries";
import { BillingSummary } from "./summary";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { useConfirm } from "@/hooks/use-confirm";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T06): /dashboard/organization/billing. Owners and admins see the plan, seats, status, AI credits and
// invoices; only the owner can act. The server enforces both rules; the UI only hides what the server would refuse.

const errorAlert = (title: string, error: unknown) => (
	<Alert variant="error">
		<Icon name="warning-circle" />
		<AlertTitle>{title}</AlertTitle>
		<AlertDescription>{getReadableErrorMessage(error, t`Try again in a moment.`)}</AlertDescription>
	</Alert>
);

export function BillingPage() {
	return (
		<div className="mx-auto grid w-full max-w-[960px] content-start gap-8 px-6 pt-8 pb-16 max-sm:px-4">
			<PageHeader
				title={<Trans>Billing</Trans>}
				description={<Trans>Your plan, seats, payments and AI credits.</Trans>}
			/>
			<BillingBody />
		</div>
	);
}

function BillingBody() {
	const { i18n } = useLingui();
	const locale = i18n.locale;
	const billing = useBilling();
	const canView = billing.isSuccess;
	const credits = useAiCredits(canView);
	const invoices = useInvoices(canView);

	if (billing.isPending) return <Skeleton className="h-40 rounded-xl" />;
	if (billing.error) {
		const denied = (billing.error as { code?: string }).code === "FORBIDDEN";
		return denied ? (
			<Alert data-testid="billing-denied">
				<Icon name="warning-circle" />
				<AlertTitle>
					<Trans>Only owners and admins can open billing</Trans>
				</AlertTitle>
				<AlertDescription>
					<Trans>Ask the owner of your organization about the plan or payments.</Trans>
				</AlertDescription>
			</Alert>
		) : (
			errorAlert(t`Couldn't load billing`, billing.error)
		);
	}

	const data = billing.data;
	const lastMethod = invoices.data?.invoices.find((invoice) => invoice.method !== null)?.method ?? null;
	return (
		<>
			<BillingSummary billing={data} credits={credits.data} method={lastMethod} locale={locale} />
			{!data.billingEnabled && (
				<Alert data-testid="billing-off">
					<Icon name="info" />
					<AlertTitle>
						<Trans>Billing is managed by the platform</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>Your plan is set for you. There is nothing to pay here.</Trans>
					</AlertDescription>
				</Alert>
			)}
			{!data.canManage && data.billingEnabled && (
				<p className="text-sm text-ink-2" data-testid="billing-owner-only">
					<Trans>Only the owner can change the plan, seats or payment details.</Trans>
				</p>
			)}
			<PlansAndCheckout
				plans={data.plans}
				planId={data.planId}
				memberCount={data.memberCount}
				seats={data.subscription.seats}
				locale={locale}
				canAct={data.canManage && data.billingEnabled}
				canStartTrial={data.canStartTrial}
			/>
			{data.canManage && data.billingEnabled && data.subscription.status === "active" && (
				<ManageSection
					memberCount={data.memberCount}
					seats={data.subscription.seats}
					seatLimit={data.plans.find((plan) => plan.id === data.planId)?.seatLimit ?? null}
					periodEnd={data.subscription.currentPeriodEnd}
					locale={locale}
				/>
			)}
			<BillingDetails canEdit={data.canManage} />
			{invoices.data ? (
				<InvoiceList invoices={invoices.data.invoices} locale={locale} />
			) : invoices.error ? (
				errorAlert(t`Couldn't load invoices`, invoices.error)
			) : (
				<Skeleton className="h-24 rounded-xl" />
			)}
		</>
	);
}

type PlansAndCheckoutProps = {
	plans: PlanListing[];
	planId: string;
	memberCount: number;
	seats: number;
	locale: string;
	canAct: boolean;
	canStartTrial: boolean;
};

function PlansAndCheckout(props: PlansAndCheckoutProps) {
	const { plans, planId, memberCount, seats, locale, canAct, canStartTrial } = props;
	const queryClient = useQueryClient();
	const [selected, setSelected] = useState<string | null>(null);
	const plan = plans.find((entry) => entry.id === selected) ?? null;
	const checkout = useMutation(
		orpc.billing.checkout.mutationOptions({
			onSuccess: (result) => {
				if (result.redirectUrl) window.location.assign(result.redirectUrl);
				else if (result.stkPushRequested) {
					toast.add({ description: t`Approve the payment on your phone.` });
					window.location.assign("/dashboard/organization/billing/return");
				}
			},
			onError: (error) =>
				toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't start the payment.`) }),
		}),
	);
	const trial = useMutation(
		orpc.billing.startTrial.mutationOptions({
			onSuccess: async () => {
				toast.add({ description: t`Your 14-day trial has started.` });
				await queryClient.invalidateQueries({ queryKey: orpc.billing.key() });
			},
			onError: (error) =>
				toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't start the trial.`) }),
		}),
	);
	const submit = (choice: CheckoutChoice) =>
		checkout.mutate(
			toCheckoutInput(
				{ planId: choice.planId as "starter" | "pro", interval: choice.interval, seats: choice.seats },
				choice.method,
			),
		);

	return (
		<>
			<SettingsSection
				title={<Trans>Plans</Trans>}
				action={
					canAct && canStartTrial ? (
						<Button variant="secondary" disabled={trial.isPending} onClick={() => trial.mutate(undefined)}>
							<Trans>Start 14-day trial</Trans>
						</Button>
					) : undefined
				}
			>
				<PlanCards
					plans={plans}
					currentPlanId={planId}
					locale={locale}
					canManage={canAct}
					selectedId={selected}
					onSelect={setSelected}
				/>
			</SettingsSection>
			{canAct && plan && (
				<CheckoutForm
					key={plan.id}
					plan={plan}
					memberCount={memberCount}
					initialSeats={plan.id === planId ? seats : memberCount}
					locale={locale}
					methodSelectable={methodSelectable()}
					busy={checkout.isPending}
					onSubmit={submit}
					onCancel={() => setSelected(null)}
				/>
			)}
		</>
	);
}

type ManageSectionProps = {
	memberCount: number;
	seats: number;
	seatLimit: number | null;
	periodEnd: Date | null;
	locale: string;
};

/** Seats, card and cancel for an organization that pays. The provider confirms each change by webhook. */
export function ManageSection({ memberCount, seats, seatLimit, periodEnd, locale }: ManageSectionProps) {
	const seatsId = useId();
	const confirm = useConfirm();
	const queryClient = useQueryClient();
	const [wanted, setWanted] = useState(seats);
	const problem = seatProblem(wanted, memberCount, seatLimit);
	const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.billing.key() });
	const fail = (fallback: string) => (error: unknown) =>
		toast.add({ type: "error", description: getReadableErrorMessage(error, fallback) });
	const changeSeats = useMutation(
		orpc.billing.changeSeats.mutationOptions({
			onSuccess: async () => {
				toast.add({ description: t`Seat change sent. It shows once the payment provider confirms.` });
				await refresh();
			},
			onError: fail(t`Couldn't change the seats.`),
		}),
	);
	const portal = useMutation(
		orpc.billing.portal.mutationOptions({
			onSuccess: (result) => window.location.assign(result.url),
			onError: fail(t`The payment provider has no billing page to open.`),
		}),
	);
	const cancel = useMutation(
		orpc.billing.cancel.mutationOptions({
			onSuccess: async () => {
				toast.add({ description: t`Cancellation sent. It shows once the payment provider confirms.` });
				await refresh();
			},
			onError: fail(t`Couldn't cancel.`),
		}),
	);
	const end = periodEnd?.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
	const onCancel = async () => {
		const ok = await confirm(t`Cancel this subscription?`, {
			description: end
				? t`Your organization keeps working until ${end}, when the paid period ends. Nothing is charged after that.`
				: t`Your organization keeps working until the paid period ends. Nothing is charged after that.`,
			confirmText: t`Cancel subscription`,
			cancelText: t`Keep it`,
		});
		if (ok !== null) cancel.mutate(undefined);
	};
	return (
		<SettingsSection title={<Trans>Manage</Trans>}>
			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					if (!problem && wanted !== seats) changeSeats.mutate({ seats: wanted });
				}}
			>
				<div className="grid gap-1.5">
					<Label htmlFor={seatsId}>
						<Trans>Seats</Trans>
					</Label>
					<Input
						id={seatsId}
						type="number"
						className="w-28"
						min={minimumSeats(memberCount)}
						value={Number.isNaN(wanted) ? "" : wanted}
						aria-invalid={problem !== null}
						onChange={(event) => setWanted(event.target.valueAsNumber)}
					/>
				</div>
				<Button
					type="submit"
					variant="secondary"
					disabled={changeSeats.isPending || problem !== null || wanted === seats}
				>
					<Trans>Update seats</Trans>
				</Button>
				{problem === "below_members" && (
					<p role="alert" className="basis-full text-[13px] text-danger-text">
						<Trans>
							Your organization has {memberCount} members, so it needs at least {memberCount} seats. Remove members
							first.
						</Trans>
					</p>
				)}
			</form>
			<div className="flex flex-wrap gap-2">
				<Button variant="secondary" disabled={portal.isPending} onClick={() => portal.mutate(undefined)}>
					<Trans>Update card or cancel</Trans>
				</Button>
				<Button variant="ghost" disabled={cancel.isPending} onClick={() => void onCancel()}>
					<Trans>Cancel subscription</Trans>
				</Button>
			</div>
		</SettingsSection>
	);
}
