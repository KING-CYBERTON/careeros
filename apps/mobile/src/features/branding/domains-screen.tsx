import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { recheckWaitSeconds } from "@reactive-resume/utils/brand-form";
import { useOrganizationAdmin } from "./access";
import { canRecheck, errorCode, needsRecords, type DomainStatus } from "./logic";
import { client, orpc, type RouterOutput } from "@/api/client";
import { useSession } from "@/auth/session";
import { Banner, Button, Card, ConfirmDialog, Screen, Skeleton, Text, TextField, showToast, useTheme } from "@/ui";

/** Settings → Domains for owners and admins. The API checks the role on every call; the gate here is a convenience. */
export function DomainsScreen() {
	const { t } = useLingui();
	const access = useOrganizationAdmin();
	return (
		<Screen>
			<Stack.Screen options={{ title: t`Domains` }} />
			{access === "loading" ? (
				<Skeleton height={160} />
			) : access === "denied" ? (
				<Banner tone="warn" icon="lock" message={t`Only owners and admins can manage the organization's domains.`} />
			) : (
				<DomainsBody />
			)}
		</Screen>
	);
}

function DomainsBody() {
	const { t } = useLingui();
	const { server } = useSession();
	const info = useQuery({
		...orpc.organizationDomain.info.queryOptions(),
		queryKey: [...orpc.organizationDomain.info.key(), server],
		retry: false,
	});
	const domains = useQuery({
		...orpc.organizationDomain.list.queryOptions(),
		queryKey: [...orpc.organizationDomain.list.key(), server],
		retry: false,
		// A domain waiting on DNS or a certificate changes without anyone touching the screen.
		refetchInterval: (query) =>
			query.state.data?.some((d) => d.status === "pending" || d.status === "verified") ? 30_000 : false,
	});
	if (info.isPending || domains.isPending) return <Skeleton height={160} />;
	if (info.isError || domains.isError)
		return (
			<Banner
				tone="danger"
				message={t`Couldn't load domains.`}
				action={{ label: t`Try again`, onPress: () => void Promise.all([info.refetch(), domains.refetch()]) }}
			/>
		);

	return (
		<>
			{info.data.subdomainHost ? (
				<Card>
					<View style={{ gap: 8 }}>
						<Text variant="heading">{t`Your address`}</Text>
						<Text
							variant="callout"
							color="ink3"
						>{t`This address always works, whatever happens to your own domains.`}</Text>
						<Text variant="mono" selectable>
							{info.data.subdomainHost}
						</Text>
						<CopyButton value={info.data.subdomainUrl ?? info.data.subdomainHost} label={t`Copy address`} />
					</View>
				</Card>
			) : null}

			{info.data.domainsConfigured ? (
				<AddDomain count={domains.data.length} limit={info.data.domainLimit} />
			) : (
				<Banner
					tone="info"
					icon="warning-circle"
					title={t`Custom domains aren't available on this server`}
					message={t`Ask the platform administrator to set up custom domains. Your address above keeps working.`}
				/>
			)}

			{domains.data.map((domain) => (
				<DomainCard key={domain.id} domain={domain} configured={info.data.domainsConfigured} />
			))}
		</>
	);
}

type CopyButtonProps = { value: string; label: string };

function CopyButton({ value, label }: CopyButtonProps) {
	const { t } = useLingui();
	return (
		<Button
			label={label}
			variant="ghost"
			icon="copy"
			onPress={() => {
				void Clipboard.setStringAsync(value).then(
					() => showToast({ message: t`Copied.` }),
					() => showToast({ message: t`Couldn't copy. Select the text instead.` }),
				);
			}}
		/>
	);
}

type AddDomainProps = { count: number; limit: number };

function AddDomain({ count, limit }: AddDomainProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [hostname, setHostname] = useState("");
	const full = count >= limit;
	const add = useMutation({
		mutationFn: () => client.organizationDomain.add({ hostname: hostname.trim() }),
		onSuccess: () => {
			setHostname("");
			showToast({ message: t`Domain added. Create the DNS records shown below.` });
		},
		onError: (error) =>
			showToast({
				message:
					errorCode(error) === "CONFLICT"
						? t`That domain isn't available, or you have reached the limit.`
						: t`Couldn't add the domain. Check the name and try again.`,
			}),
		onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.organizationDomain.list.key() }),
	});
	return (
		<Card>
			<View style={{ gap: 12 }}>
				<Text variant="heading">{t`Add a domain`}</Text>
				<Text variant="callout" color="ink3">{t`${count} of ${limit} domains used.`}</Text>
				<TextField
					label={t`Domain`}
					value={hostname}
					placeholder="careers.example.com"
					autoCapitalize="none"
					autoCorrect={false}
					keyboardType="url"
					editable={!full}
					onChangeText={setHostname}
				/>
				<Button
					label={t`Add domain`}
					icon="plus"
					loading={add.isPending}
					disabled={full || hostname.trim() === ""}
					onPress={() => add.mutate()}
				/>
			</View>
		</Card>
	);
}

type Domain = RouterOutput["organizationDomain"]["list"][number];

type DomainCardProps = { domain: Domain; configured: boolean };

function DomainCard({ domain, configured }: DomainCardProps) {
	const { t } = useLingui();
	const { space } = useTheme();
	const queryClient = useQueryClient();
	const status = domain.status as DomainStatus;
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const [blockedUntil, setBlockedUntil] = useState(0);
	const wait = Math.max(recheckWaitSeconds(domain.lastCheckedAt, now), Math.ceil((blockedUntil - now) / 1000));
	useEffect(() => {
		if (wait <= 0) return;
		const timer = setTimeout(() => setNow(Date.now()), 1000);
		return () => clearTimeout(timer);
	}, [wait, now]);
	const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.organizationDomain.list.key() });

	const recheck = useMutation({
		mutationFn: () => client.organizationDomain.recheck({ id: domain.id }),
		onError: (error) => {
			if (errorCode(error) === "TOO_MANY_REQUESTS") {
				const at = Date.now();
				setNow(at);
				setBlockedUntil(at + 60_000);
			} else showToast({ message: t`Couldn't check the domain. Try again.` });
		},
		onSettled: refresh,
	});
	const remove = useMutation({
		mutationFn: () => client.organizationDomain.remove({ id: domain.id }),
		onSuccess: () => showToast({ message: t`Removed ${domain.hostname}` }),
		onError: () => showToast({ message: t`Couldn't remove the domain. Try again.` }),
		onSettled: () => {
			setConfirmRemove(false);
			refresh();
		},
	});

	const label = {
		pending: t`Waiting for DNS`,
		verified: t`Issuing certificate`,
		active: t`Active`,
		failed: t`Failed`,
		removing: t`Removing`,
	}[status];
	const hint = {
		pending: t`Create the two records below at your DNS provider. We check every few minutes.`,
		verified: t`Ownership is proven. The certificate is being issued; this usually takes a few minutes.`,
		active: t`Your organization is served on this domain.`,
		failed: t`Remove the domain and add it again once the cause is fixed.`,
		removing: t`This domain no longer serves your organization and is being deleted.`,
	}[status];
	const failures: Record<string, string> = {
		verification_timeout: t`We didn't find the ownership record in time. Check that the TXT record exists exactly as shown.`,
		txt_missing: t`The ownership TXT record is gone. Add it back, or remove the domain.`,
		cloudflare_rejected: t`The certificate provider rejected this domain. Check that the CNAME record points where shown.`,
		cloudflare_moved: t`The domain's certificate setup was changed and can't be used. Remove the domain and add it again.`,
		cloudflare_deleted: t`The domain's certificate setup was changed and can't be used. Remove the domain and add it again.`,
		hostname_taken: t`Another account claimed this domain first.`,
	};
	const failure = domain.failureReason
		? (failures[domain.failureReason] ??
			t`Something went wrong while checking this domain. Remove it and add it again.`)
		: null;

	return (
		<Card>
			<View style={{ gap: space.s3 }}>
				<Text variant="heading">{domain.hostname}</Text>
				<Banner
					tone={
						status === "failed" ? "danger" : status === "active" ? "accent" : status === "removing" ? "info" : "warn"
					}
					title={label}
					message={hint}
				/>
				{failure ? (
					<Text variant="callout" color="ink2">
						{failure}
					</Text>
				) : null}
				{domain.cfSslStatus ? (
					<Text variant="callout" color="ink3">{t`Certificate: ${domain.cfSslStatus}`}</Text>
				) : null}
				{needsRecords(status)
					? domain.records.map((record) => (
							<View key={`${record.type}-${record.name}`} style={{ gap: space.s1 }}>
								<Text weight={600}>{record.type}</Text>
								<Text variant="callout" color="ink2" selectable>{t`Name: ${record.name}`}</Text>
								<Text variant="callout" color="ink2" selectable>{t`Value: ${record.value}`}</Text>
								<CopyButton value={record.value} label={t`Copy ${record.type} value`} />
							</View>
						))
					: null}
				<View style={{ flexDirection: "row", gap: space.s2, flexWrap: "wrap" }}>
					{configured && canRecheck(status) ? (
						<Button
							label={wait > 0 ? t`Check again in ${wait}s` : t`Check now`}
							variant="secondary"
							icon="arrows-clockwise"
							loading={recheck.isPending}
							disabled={wait > 0}
							onPress={() => recheck.mutate()}
						/>
					) : null}
					{status !== "removing" ? (
						<Button label={t`Remove`} variant="ghost" onPress={() => setConfirmRemove(true)} />
					) : null}
				</View>
			</View>
			<ConfirmDialog
				open={confirmRemove}
				title={t`Remove ${domain.hostname}?`}
				message={t`It stops serving your organization right away (other servers within about a minute). Members can still use your address.`}
				confirmLabel={t`Remove domain`}
				destructive
				onConfirm={() => remove.mutate()}
				onCancel={() => setConfirmRemove(false)}
			/>
		</Card>
	);
}
