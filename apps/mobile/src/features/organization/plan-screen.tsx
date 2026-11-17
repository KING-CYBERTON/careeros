// CAREEROS (P3-T06, phase plan D10): Settings → Plan, read-only. Every member sees the plan, status, seats and AI quota.
// Owners and admins also see the trial days left, the grace end date and the period, from the same read the web billing
// page uses. There are no prices, no purchase or upgrade action and no link to web checkout: app store rules restrict
// selling subscriptions outside in-app purchase, so owners manage billing on the web (recorded in the Mobile parity gaps).
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { View } from "react-native";
import { useEntitlements } from "./entitlements";
import { daysLeft, planNameFor, quotaView } from "./plan-view";
import { orpc } from "@/api/client";
import { useSession } from "@/auth/session";
import { useOrganizationAdmin } from "@/features/branding/access";
import { Banner, Card, Screen, Skeleton, Text, useTheme } from "@/ui";

export function PlanScreen() {
	const { t } = useLingui();
	return (
		<Screen>
			<Stack.Screen options={{ title: t`Plan` }} />
			<PlanBody />
		</Screen>
	);
}

type RowProps = { label: string; value: string; testID?: string };

function Row({ label, value, testID }: RowProps) {
	const { space } = useTheme();
	return (
		<View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.s3 }}>
			<Text variant="callout" color="ink3">
				{label}
			</Text>
			<Text variant="callout" testID={testID}>
				{value}
			</Text>
		</View>
	);
}

function PlanBody() {
	const { t } = useLingui();
	const { space } = useTheme();
	const { server, status: sessionStatus } = useSession();
	const entitlements = useEntitlements();
	const admin = useOrganizationAdmin() === "allowed";
	const quota = useQuery({
		...orpc.ai.quota.queryOptions(),
		queryKey: [...orpc.ai.quota.key(), server],
		enabled: sessionStatus === "signed-in",
		retry: false,
	});
	const detail = useQuery({
		...orpc.billing.get.queryOptions(),
		queryKey: [...orpc.billing.get.key(), server],
		enabled: admin,
		retry: false,
	});

	if (entitlements.isPending) return <Skeleton height={160} />;
	if (entitlements.isError || !entitlements.data)
		return (
			<Banner
				tone="danger"
				message={t`Couldn't load the plan.`}
				action={{ label: t`Try again`, onPress: () => void entitlements.refetch() }}
			/>
		);

	const plan = entitlements.data;
	const statusLabel = {
		trial: t`Trial`,
		active: t`Active`,
		past_due: t`Past due`,
		suspended: t`Suspended`,
	}[plan.status];
	const trialDays = daysLeft(detail.data?.subscription.trialEndsAt);
	const graceEnd = detail.data?.subscription.graceEndsAt?.toLocaleDateString();
	const periodEnd = detail.data?.subscription.currentPeriodEnd?.toLocaleDateString();
	const credits = quota.data ? quotaView(quota.data) : null;

	return (
		<View style={{ gap: space.s4 }}>
			{plan.status === "suspended" ? (
				<Banner
					tone="warn"
					icon="warning-circle"
					message={t`This organization is suspended. You can view and export your data.`}
				/>
			) : null}
			{plan.status === "past_due" ? (
				<Banner
					tone="warn"
					icon="warning-circle"
					message={
						graceEnd
							? t`A payment is overdue. Please contact your organization's owner. Service pauses after ${graceEnd}.`
							: t`A payment is overdue. Please contact your organization's owner.`
					}
				/>
			) : null}
			<Card style={{ gap: space.s3 }}>
				<Text variant="title">{planNameFor(plan.planId)}</Text>
				<Row label={t`Status`} value={statusLabel} testID="plan-status" />
				{plan.status === "trial" && trialDays !== null ? (
					<Row label={t`Trial`} value={t`${trialDays} days left`} />
				) : null}
				<Row
					label={t`Seats`}
					value={plan.seatLimit === null ? t`${plan.seatsUsed} used` : t`${plan.seatsUsed} of ${plan.seatLimit}`}
					testID="plan-seats"
				/>
				{periodEnd ? <Row label={t`Period ends`} value={periodEnd} /> : null}
			</Card>
			<Card style={{ gap: space.s3 }}>
				<Text variant="title">{t`AI quota`}</Text>
				{credits ? (
					<>
						<Row label={t`Used`} value={String(credits.used)} testID="plan-quota-used" />
						<Row label={t`Left`} value={String(credits.left)} testID="plan-quota-left" />
					</>
				) : quota.isPending ? (
					<Skeleton height={40} />
				) : (
					<Text variant="callout" color="ink3">
						{t`This plan has no pooled AI credits.`}
					</Text>
				)}
			</Card>
			<Text variant="callout" color="ink3">
				{t`Your organization's owner manages the plan and payments on the web.`}
			</Text>
		</View>
	);
}
