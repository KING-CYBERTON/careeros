import type { BillingInterval, Currency, PaymentMethod, PlanPrices } from "./lib";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useId, useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { SegmentedControl, SegmentedControlItem } from "@reactive-resume/ui/components/segmented-control";
import { formatMoney, minimumSeats, planPrice, seatProblem } from "./lib";
import { SettingsSection } from "@/features/settings/section";

// CAREEROS (P3-T06): the plan cards and the checkout form. Every price is read from the plan table (`billing.get`).

export type PlanListing = PlanPrices & {
	id: string;
	name: string;
	seatLimit: number | null;
	aiCreditsPerSeat: number;
	selfService: boolean;
};

type PlanPriceLinesProps = { plan: PlanPrices; locale: string };

function PlanPriceLines({ plan, locale }: PlanPriceLinesProps) {
	const lines = (["month", "year"] as const).map((interval) => {
		const parts = (["KES", "USD"] as const).map((currency) => {
			const price = planPrice(plan, interval, currency);
			return price ? formatMoney(price.amount, currency, locale) : null;
		});
		const perSeat = plan.pricingModel === "per_seat";
		return { interval, parts: parts.filter((part): part is string => part !== null), perSeat };
	});
	return (
		<dl className="grid gap-1 text-sm" data-testid="plan-prices">
			{lines.map((line) => (
				<div key={line.interval} className="flex justify-between gap-2">
					<dt className="text-ink-3">{line.interval === "month" ? t`Monthly` : t`Annual`}</dt>
					<dd className="text-end tabular-nums">
						{line.parts.length === 0 ? (
							<Trans>Contact us</Trans>
						) : (
							<>
								{line.parts.join(" · ")}
								{line.perSeat ? ` ${t`per seat`}` : ""}
							</>
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}

type PlanCardsProps = {
	plans: PlanListing[];
	currentPlanId: string;
	locale: string;
	/** Only the owner can pick a plan. */
	canManage: boolean;
	selectedId: string | null;
	onSelect: (planId: string) => void;
};

export function PlanCards({ plans, currentPlanId, locale, canManage, selectedId, onSelect }: PlanCardsProps) {
	return (
		<ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="plan-cards">
			{plans.map((plan) => {
				const current = plan.id === currentPlanId;
				return (
					<li
						key={plan.id}
						data-testid={`plan-card-${plan.id}`}
						className="grid content-start gap-3 rounded-xl p-4 outline outline-line data-[selected=true]:outline-2 data-[selected=true]:outline-ink"
						data-selected={selectedId === plan.id}
					>
						<div className="flex items-center justify-between gap-2">
							<h3 className="text-base font-semibold">{plan.name}</h3>
							{current && (
								<Badge variant="accent">
									<Trans>Current plan</Trans>
								</Badge>
							)}
						</div>
						<PlanPriceLines plan={plan} locale={locale} />
						<p className="text-[13px] text-ink-3">
							{plan.seatLimit === null ? <Trans>Unlimited seats</Trans> : <Trans>Up to {plan.seatLimit} seats</Trans>}
							{" · "}
							<Trans>{plan.aiCreditsPerSeat} AI credits per seat each month</Trans>
						</p>
						{canManage &&
							(plan.selfService ? (
								<Button
									variant={current ? "secondary" : "primary"}
									onClick={() => onSelect(plan.id)}
									aria-label={current ? t`Change ${plan.name}` : t`Choose ${plan.name}`}
								>
									{current ? <Trans>Change seats or interval</Trans> : <Trans>Choose</Trans>}
								</Button>
							) : (
								<p className="text-[13px] text-ink-2">
									<Trans>Contact us to buy this plan.</Trans>
								</p>
							))}
					</li>
				);
			})}
		</ul>
	);
}

export type CheckoutChoice = { planId: string; interval: BillingInterval; seats: number; method: PaymentMethod };

type CheckoutFormProps = {
	plan: PlanListing;
	memberCount: number;
	initialSeats: number;
	locale: string;
	/** Whether to ask card or M-Pesa; see checkout-adapter.ts. */
	methodSelectable: boolean;
	busy: boolean;
	onSubmit: (choice: CheckoutChoice) => void;
	onCancel: () => void;
};

export function CheckoutForm(props: CheckoutFormProps) {
	const { plan, memberCount, locale, methodSelectable, busy, onSubmit, onCancel } = props;
	const seatsId = useId();
	const [interval, setInterval] = useState<BillingInterval>("month");
	const [seats, setSeats] = useState(Math.max(props.initialSeats, minimumSeats(memberCount)));
	const [method, setMethod] = useState<PaymentMethod>("card");
	const problem = seatProblem(seats, memberCount, plan.seatLimit);
	const seatLimit = plan.seatLimit ?? 0;
	const message =
		problem === "below_members"
			? t`Your organization has ${memberCount} members, so it needs at least ${memberCount} seats. Remove members first.`
			: problem === "over_limit"
				? t`This plan allows at most ${seatLimit} seats.`
				: problem === "invalid"
					? t`Enter a whole number of seats, at least 1.`
					: null;
	const currencies: Currency[] = ["KES", "USD"];
	const shown = currencies
		.map((currency) => planPrice(plan, interval, currency))
		.map((price, index) => (price ? formatMoney(price.amount, currencies[index] ?? "USD", locale) : null))
		.filter((value): value is string => value !== null);

	return (
		<SettingsSection title={<Trans>Pay for {plan.name}</Trans>} className="max-w-none">
			<form
				className="grid max-w-md gap-4"
				data-testid="checkout-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (!problem) onSubmit({ planId: plan.id, interval, seats, method });
				}}
			>
				<div className="grid gap-1.5">
					<Label>
						<Trans>Billing interval</Trans>
					</Label>
					<SegmentedControl
						aria-label={t`Billing interval`}
						value={interval}
						onValueChange={(value) => setInterval(value as BillingInterval)}
					>
						<SegmentedControlItem value="month">
							<Trans>Monthly</Trans>
						</SegmentedControlItem>
						<SegmentedControlItem value="year">
							<Trans>Annual</Trans>
						</SegmentedControlItem>
					</SegmentedControl>
				</div>
				<div className="grid gap-1.5">
					<Label htmlFor={seatsId}>
						<Trans>Seats</Trans>
					</Label>
					<Input
						id={seatsId}
						type="number"
						min={minimumSeats(memberCount)}
						max={plan.seatLimit ?? undefined}
						value={Number.isNaN(seats) ? "" : seats}
						aria-invalid={problem !== null}
						aria-describedby={message ? `${seatsId}-error` : undefined}
						onChange={(event) => setSeats(event.target.valueAsNumber)}
					/>
					{message && (
						<p id={`${seatsId}-error`} role="alert" className="text-[13px] text-danger-text" data-testid="seat-error">
							{message}
						</p>
					)}
				</div>
				{methodSelectable && (
					<div className="grid gap-1.5">
						<Label>
							<Trans>Payment method</Trans>
						</Label>
						<SegmentedControl
							aria-label={t`Payment method`}
							value={method}
							onValueChange={(value) => setMethod(value as PaymentMethod)}
						>
							<SegmentedControlItem value="card">
								<Trans>Card</Trans>
							</SegmentedControlItem>
							<SegmentedControlItem value="mpesa">
								<Trans>M-Pesa</Trans>
							</SegmentedControlItem>
						</SegmentedControl>
						<p className="text-[13px] text-ink-3" data-testid="method-note">
							{method === "card" ? (
								<Trans>Card renews automatically.</Trans>
							) : (
								<Trans>M-Pesa pays one period at a time. You pay again when the period ends.</Trans>
							)}
						</p>
					</div>
				)}
				{shown.length > 0 && (
					<p className="text-sm text-ink-2">
						{interval === "month" ? <Trans>Listed price per month:</Trans> : <Trans>Listed price per year:</Trans>}{" "}
						{shown.join(" · ")}
						{plan.pricingModel === "per_seat" ? ` ${t`per seat`}` : ""}
					</p>
				)}
				<div className="flex gap-2">
					<Button type="submit" disabled={busy || problem !== null}>
						<Trans>Continue to payment</Trans>
					</Button>
					<Button type="button" variant="ghost" onClick={onCancel}>
						<Trans>Cancel</Trans>
					</Button>
				</div>
			</form>
		</SettingsSection>
	);
}
