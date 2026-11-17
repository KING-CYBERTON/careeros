import type { ReactNode } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { ErrorNotice, formatDate, notify, formatMicros, formatMoney } from "./shared";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P3-T07): one organization in full, and every action an admin can take on it. Each action needs a typed
// reason of at least 10 characters (the server and the database both check), and each is recorded in the audit log.

const MIN_REASON = 10;

type FieldProps = { label: string; children: ReactNode };
function Field({ label, children }: FieldProps) {
	return (
		// The control sits inside the label, so the label names it for screen readers and for tests alike.
		<Label className="grid items-stretch gap-1.5">
			<span>{label}</span>
			{children}
		</Label>
	);
}

type ReasonFieldProps = { value: string; onChange: (value: string) => void };
function ReasonField({ value, onChange }: ReasonFieldProps) {
	return (
		<Field label={t`Reason (recorded in the audit log)`}>
			<Input
				value={value}
				maxLength={500}
				placeholder={t`At least 10 characters`}
				onChange={(event) => onChange(event.target.value)}
			/>
		</Field>
	);
}

const reasonOk = (reason: string) => reason.trim().length >= MIN_REASON;

type OrganizationPageProps = { organizationId: string };

export function OrganizationPage({ organizationId }: OrganizationPageProps) {
	const query = useQuery(orpc.admin.orgs.get.queryOptions({ input: { organizationId } }));
	if (query.error) return <ErrorNotice error={query.error} title={<Trans>Couldn't load this organization</Trans>} />;
	if (!query.data) return <Skeleton className="h-96 rounded-xl" />;
	const detail = query.data;
	const org = detail.organization;

	return (
		<div className="grid gap-6">
			<PageHeader
				back={
					<Link to="/admin/organizations" className="text-sm text-ink-3 hover:text-ink">
						<Trans>All organizations</Trans>
					</Link>
				}
				title={org.name}
				description={
					<span className="flex flex-wrap items-center gap-2">
						<code>{org.slug}</code>
						<Badge variant={org.status === "suspended" ? "danger" : "accent"}>{org.status}</Badge>
						<Badge>{detail.plan.name}</Badge>
					</span>
				}
			/>

			<SettingsSection title={<Trans>Overview</Trans>}>
				<dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2" data-testid="admin-org-overview">
					<Item label={t`Created`} value={formatDate(org.createdAt)} />
					<Item label={t`Status changed`} value={formatDate(org.statusChangedAt)} />
					<Item
						label={t`Seats`}
						value={`${detail.seats.used} / ${detail.seats.limit ?? "∞"} (${detail.seats.members} members, ${detail.seats.pendingInvitations} invited)`}
					/>
					<Item
						label={t`Subscription`}
						value={
							detail.subscription
								? `${detail.subscription.provider}, ${detail.subscription.status}, ${detail.subscription.seats} seats`
								: "-"
						}
					/>
					<Item label={t`Period ends`} value={formatDate(detail.subscription?.currentPeriodEnd)} />
					<Item label={t`Trial ends`} value={formatDate(detail.subscription?.trialEndsAt)} />
					<Item label={t`AI overage`} value={detail.subscription?.aiOverageAllowed ? t`Allowed` : t`Not allowed`} />
					<Item
						label={t`Owners`}
						value={detail.owners.map((owner) => `${owner.name} <${owner.email}>`).join(", ") || "-"}
					/>
				</dl>
			</SettingsSection>

			<SettingsSection
				title={<Trans>AI usage this period</Trans>}
				description={`${formatDate(detail.aiUsage.periodStart)} - ${formatDate(detail.aiUsage.periodEnd)}`}
			>
				<p className="text-sm" data-testid="admin-org-ai">
					{detail.aiUsage.credits} / {detail.aiUsage.creditsTotal} credits, {detail.aiUsage.calls} calls,{" "}
					{formatMicros(detail.aiUsage.costUsdMicros)}
				</p>
				<ul className="grid gap-1 text-sm text-ink-2">
					{detail.aiUsage.byFeature.map((row) => (
						<li key={row.feature}>
							{row.feature}: {row.credits} credits, {row.calls} calls, {formatMicros(row.costUsdMicros)}
						</li>
					))}
				</ul>
			</SettingsSection>

			<StatusForm organizationId={organizationId} status={org.status} />
			<PlanForm organizationId={organizationId} planId={detail.plan.id} seats={detail.subscription?.seats ?? null} />
			<OverageForm organizationId={organizationId} allowed={detail.subscription?.aiOverageAllowed ?? false} />
			<PaymentForm organizationId={organizationId} planId={detail.plan.id} seats={detail.subscription?.seats ?? 1} />
			<SupportSessionForm organizationId={organizationId} owners={detail.owners} />

			<SettingsSection title={<Trans>Recent billing events</Trans>}>
				<ul className="grid gap-1 text-sm text-ink-2">
					{detail.billingEvents.map((event) => (
						<li key={`${event.provider}-${event.type}-${event.receivedAt}`}>
							{formatDate(event.receivedAt)}: {event.provider} {event.type} ({event.outcome})
						</li>
					))}
					{detail.billingEvents.length === 0 && <li className="text-ink-3">{t`None yet.`}</li>}
				</ul>
			</SettingsSection>
		</div>
	);
}

type ItemProps = { label: string; value: ReactNode };
function Item({ label, value }: ItemProps) {
	return (
		<div className="grid gap-0.5">
			<dt className="text-xs text-ink-3">{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}

/** Runs a console mutation: refreshes the organization, says what happened, and shows the server's refusal. */
function useAdminAction(organizationId: string, done: string) {
	const queryClient = useQueryClient();
	return {
		onSuccess: async () => {
			notify.success(done);
			await queryClient.invalidateQueries({ queryKey: orpc.admin.orgs.get.queryKey({ input: { organizationId } }) });
			await queryClient.invalidateQueries({ queryKey: orpc.admin.orgs.list.key() });
		},
		onError: (error: unknown) => notify.error(getReadableErrorMessage(error, t`The change could not be made.`)),
	};
}

type StatusFormProps = { organizationId: string; status: string };
function StatusForm({ organizationId, status }: StatusFormProps) {
	const [reason, setReason] = useState("");
	const next = status === "suspended" ? "active" : "suspended";
	const action = useAdminAction(
		organizationId,
		next === "suspended" ? t`Organization suspended.` : t`Organization reactivated.`,
	);
	const mutation = useMutation(orpc.admin.orgs.setStatus.mutationOptions(action));
	return (
		<SettingsSection
			title={next === "suspended" ? <Trans>Suspend</Trans> : <Trans>Reactivate</Trans>}
			description={
				next === "suspended" ? (
					<Trans>A suspended organization can sign in and export, and cannot write.</Trans>
				) : (
					<Trans>Lifts the suspension.</Trans>
				)
			}
		>
			<form
				className="grid max-w-md gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					mutation.mutate({ organizationId, status: next, reason: reason.trim() }, { onSuccess: () => setReason("") });
				}}
			>
				<ReasonField value={reason} onChange={setReason} />
				<Button
					type="submit"
					variant={next === "suspended" ? "danger" : "primary"}
					loading={mutation.isPending}
					disabled={!reasonOk(reason)}
					className="w-fit"
				>
					{next === "suspended" ? t`Suspend organization` : t`Reactivate organization`}
				</Button>
			</form>
		</SettingsSection>
	);
}

type PlanFormProps = { organizationId: string; planId: string; seats: number | null };
function PlanForm({ organizationId, planId, seats }: PlanFormProps) {
	const plans = useQuery(orpc.admin.plans.queryOptions());
	const [plan, setPlan] = useState(planId);
	const [seatCount, setSeatCount] = useState(seats === null ? "" : String(seats));
	const [reason, setReason] = useState("");
	const mutation = useMutation(
		orpc.admin.orgs.setPlan.mutationOptions(useAdminAction(organizationId, t`Plan changed.`)),
	);
	const seatValue = seatCount.trim() === "" ? null : Number(seatCount);
	const seatsValid = seatValue === null || (Number.isInteger(seatValue) && seatValue >= 1);
	return (
		<SettingsSection
			title={<Trans>Plan</Trans>}
			description={<Trans>Assign a plan and, if needed, the seats on the subscription.</Trans>}
		>
			<form
				className="grid max-w-md gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					mutation.mutate(
						{ organizationId, planId: plan, seats: seatValue, reason: reason.trim() },
						{ onSuccess: () => setReason("") },
					);
				}}
			>
				<Field label={t`Plan`}>
					<NativeSelect value={plan} onChange={(event) => setPlan(event.target.value)}>
						{(plans.data ?? [{ id: planId, name: planId }]).map((row) => (
							<option key={row.id} value={row.id}>
								{row.name}
							</option>
						))}
					</NativeSelect>
				</Field>
				<Field label={t`Seats (leave empty to keep)`}>
					<Input inputMode="numeric" value={seatCount} onChange={(event) => setSeatCount(event.target.value)} />
				</Field>
				<ReasonField value={reason} onChange={setReason} />
				<Button
					type="submit"
					loading={mutation.isPending}
					disabled={!reasonOk(reason) || !seatsValid}
					className="w-fit"
				>
					{t`Change plan`}
				</Button>
			</form>
		</SettingsSection>
	);
}

type OverageFormProps = { organizationId: string; allowed: boolean };
function OverageForm({ organizationId, allowed }: OverageFormProps) {
	const [reason, setReason] = useState("");
	const mutation = useMutation(
		orpc.admin.orgs.setAiOverage.mutationOptions(useAdminAction(organizationId, t`AI overage changed.`)),
	);
	return (
		<SettingsSection
			title={<Trans>AI overage</Trans>}
			description={<Trans>Lets the organization use platform AI past its plan's credits.</Trans>}
		>
			<form
				className="grid max-w-md gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					mutation.mutate(
						{ organizationId, allowed: !allowed, reason: reason.trim() },
						{ onSuccess: () => setReason("") },
					);
				}}
			>
				<ReasonField value={reason} onChange={setReason} />
				<Button
					type="submit"
					variant="secondary"
					loading={mutation.isPending}
					disabled={!reasonOk(reason)}
					className="w-fit"
				>
					{allowed ? t`Stop allowing overage` : t`Allow overage`}
				</Button>
			</form>
		</SettingsSection>
	);
}

type PaymentFormProps = { organizationId: string; planId: string; seats: number };
function PaymentForm({ organizationId, planId, seats }: PaymentFormProps) {
	const plans = useQuery(orpc.admin.plans.queryOptions());
	const [plan, setPlan] = useState(planId);
	const [seatCount, setSeatCount] = useState(String(seats));
	const [interval, setInterval] = useState<"month" | "year">("month");
	const [periodStart, setPeriodStart] = useState(() => new Date().toISOString().slice(0, 10));
	const [periodEnd, setPeriodEnd] = useState("");
	const [amount, setAmount] = useState("");
	const [currency, setCurrency] = useState("USD");
	const [reference, setReference] = useState("");
	const mutation = useMutation(
		orpc.admin.payments.record.mutationOptions({
			onSuccess: async (applied) => {
				notify.success(applied ? t`Payment recorded.` : t`That reference was already recorded. Nothing changed.`);
				await Promise.resolve();
			},
			onError: (error: unknown) => notify.error(getReadableErrorMessage(error, t`The payment could not be recorded.`)),
		}),
	);
	const amountMinor = Math.round(Number(amount) * 100);
	const valid =
		Number.isInteger(Number(seatCount)) &&
		Number(seatCount) >= 1 &&
		periodEnd !== "" &&
		amountMinor > 0 &&
		/^[A-Z]{3}$/.test(currency) &&
		reference.trim().length > 0;
	return (
		<SettingsSection
			title={<Trans>Record a payment</Trans>}
			description={<Trans>For a payment received outside a provider. The same reference is applied once.</Trans>}
		>
			<form
				className="grid max-w-md gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					mutation.mutate(
						{
							orgId: organizationId,
							planId: plan,
							seats: Number(seatCount),
							interval,
							periodStart: new Date(`${periodStart}T00:00:00Z`),
							periodEnd: new Date(`${periodEnd}T00:00:00Z`),
							amount: amountMinor,
							currency,
							reference: reference.trim(),
						},
						{ onSuccess: () => setReference("") },
					);
				}}
			>
				<Field label={t`Plan`}>
					<NativeSelect value={plan} onChange={(event) => setPlan(event.target.value)}>
						{(plans.data ?? [{ id: planId, name: planId }]).map((row) => (
							<option key={row.id} value={row.id}>
								{row.name}
							</option>
						))}
					</NativeSelect>
				</Field>
				<div className="grid grid-cols-2 gap-3">
					<Field label={t`Seats`}>
						<Input inputMode="numeric" value={seatCount} onChange={(event) => setSeatCount(event.target.value)} />
					</Field>
					<Field label={t`Interval`}>
						<NativeSelect value={interval} onChange={(event) => setInterval(event.target.value as "month" | "year")}>
							<option value="month">{t`Monthly`}</option>
							<option value="year">{t`Yearly`}</option>
						</NativeSelect>
					</Field>
					<Field label={t`Period start`}>
						<Input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
					</Field>
					<Field label={t`Period end`}>
						<Input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
					</Field>
					<Field label={t`Amount`}>
						<Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
					</Field>
					<Field label={t`Currency`}>
						<Input maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
					</Field>
				</div>
				<Field label={t`Invoice or bank reference`}>
					<Input maxLength={128} value={reference} onChange={(event) => setReference(event.target.value)} />
				</Field>
				<Button type="submit" loading={mutation.isPending} disabled={!valid} className="w-fit">
					{t`Record payment`}
				</Button>
				{valid && <p className="text-xs text-ink-3">{formatMoney(amountMinor, currency)}</p>}
			</form>
		</SettingsSection>
	);
}

type SupportSessionFormProps = { organizationId: string; owners: { id: string; name: string; email: string }[] };
function SupportSessionForm({ organizationId, owners }: SupportSessionFormProps) {
	const [userId, setUserId] = useState(owners[0]?.id ?? "");
	const [reason, setReason] = useState("");
	const mutation = useMutation(
		orpc.admin.impersonation.start.mutationOptions({
			// The token is in the URL fragment of the member's organization host; open it in this tab.
			onSuccess: (result) => window.location.assign(result.url),
			onError: (error: unknown) =>
				notify.error(getReadableErrorMessage(error, t`The support session could not start.`)),
		}),
	);
	return (
		<SettingsSection
			title={<Trans>Support session</Trans>}
			description={
				<Trans>
					Sign in as a member of this organization for up to 60 minutes. The member sees a banner and can end it. It is
					recorded in the organization's audit log and in the platform log.
				</Trans>
			}
		>
			{owners.length === 0 ? (
				<p className="text-sm text-ink-3">
					<Trans>This organization has no owner to sign in as.</Trans>
				</p>
			) : (
				<form
					className="grid max-w-md gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						mutation.mutate({ organizationId, userId, reason: reason.trim() });
					}}
				>
					<Field label={t`Sign in as`}>
						<NativeSelect value={userId} onChange={(event) => setUserId(event.target.value)}>
							{owners.map((owner) => (
								<option key={owner.id} value={owner.id}>
									{owner.name}
								</option>
							))}
						</NativeSelect>
					</Field>
					<ReasonField value={reason} onChange={setReason} />
					<Button
						type="submit"
						variant="secondary"
						loading={mutation.isPending}
						disabled={!reasonOk(reason) || !userId}
						className="w-fit"
					>
						{t`Start support session`}
					</Button>
				</form>
			)}
		</SettingsSection>
	);
}
