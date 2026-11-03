import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { recheckWaitSeconds } from "@reactive-resume/utils/brand-form";
import { RequireBrandingAdmin } from "./access";
import { failureText, statusInfo, type DomainStatus } from "./domains";
import { useDomainInfo, useDomainMutations, useDomains } from "./queries";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { useConfirm } from "@/hooks/use-confirm";
import { getReadableErrorMessage } from "@/libs/error-message";

export function DomainsSettings() {
	return (
		<>
			<PageHeader
				title={<Trans>Domains</Trans>}
				description={<Trans>Serve your organization on your own domain.</Trans>}
			/>
			<RequireBrandingAdmin>
				<DomainsBody />
			</RequireBrandingAdmin>
		</>
	);
}

function DomainsBody() {
	const info = useDomainInfo();
	const domains = useDomains();
	// CAREEROS (P3-T02, phase plan D4): custom domains are a plan feature. The server refuses adding one without it
	// (FEATURE_NOT_IN_PLAN); this only swaps the form for a note.
	const { flags } = useRouteContext({ strict: false });
	const customDomainInPlan = flags?.features?.custom_domain === true;
	if (info.isLoading || domains.isLoading) return <Skeleton className="h-48 rounded-xl" />;
	if (info.error || domains.error || !info.data || !domains.data)
		return (
			<Alert variant="error">
				<Icon name="warning" />
				<AlertTitle>
					<Trans>Couldn't load domains</Trans>
				</AlertTitle>
				<AlertDescription>
					{getReadableErrorMessage(info.error ?? domains.error, t`Try again in a moment.`)}
				</AlertDescription>
			</Alert>
		);
	return (
		<>
			{info.data.subdomainHost && (
				<SettingsSection
					title={<Trans>Your address</Trans>}
					description={<Trans>This address always works, whatever happens to your own domains.</Trans>}
				>
					<div className="flex flex-wrap items-center gap-2">
						<code data-testid="subdomain-host" className="rounded-md bg-sunken px-2 py-1 text-sm">
							{info.data.subdomainHost}
						</code>
						<CopyButton value={info.data.subdomainUrl ?? info.data.subdomainHost} label={t`Copy address`} />
					</div>
				</SettingsSection>
			)}

			{!customDomainInPlan ? (
				<Alert variant="info" data-testid="domains-not-in-plan">
					<Icon name="lock" />
					<AlertTitle>
						<Trans>Custom domains are available on Pro</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							Your address above keeps working. Ask your administrator to upgrade the plan to add your own domain.
						</Trans>
					</AlertDescription>
				</Alert>
			) : info.data.domainsConfigured ? (
				<AddDomain count={domains.data.length} limit={info.data.domainLimit} />
			) : (
				<Alert data-testid="domains-not-configured">
					<Icon name="warning-circle" />
					<AlertTitle>
						<Trans>Custom domains aren't available on this server</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>Ask the platform administrator to set up custom domains. Your address above keeps working.</Trans>
					</AlertDescription>
				</Alert>
			)}

			{domains.data.length > 0 && (
				<SettingsSection title={<Trans>Your domains</Trans>}>
					<ul className="grid gap-4">
						{domains.data.map((domain) => (
							<DomainRow key={domain.id} domain={domain} configured={info.data.domainsConfigured} />
						))}
					</ul>
				</SettingsSection>
			)}
		</>
	);
}

type CopyButtonProps = { value: string; label: string };

function CopyButton({ value, label }: CopyButtonProps) {
	return (
		<Button
			type="button"
			size="sm"
			variant="ghost"
			aria-label={label}
			onClick={() => {
				void navigator.clipboard
					?.writeText(value)
					.then(() => toast.add({ description: t`Copied.` }))
					.catch(() => toast.add({ type: "error", description: t`Couldn't copy. Select the text instead.` }));
			}}
		>
			<Icon name="copy" size={16} />
			<Trans>Copy</Trans>
		</Button>
	);
}

type AddDomainProps = { count: number; limit: number };

function AddDomain({ count, limit }: AddDomainProps) {
	const id = useId();
	const { add } = useDomainMutations();
	const [hostname, setHostname] = useState("");
	const full = count >= limit;
	return (
		<SettingsSection
			title={<Trans>Add a domain</Trans>}
			description={
				<Trans>
					{count} of {limit} domains used.
				</Trans>
			}
		>
			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					add.mutate(
						{ hostname: hostname.trim() },
						{
							onSuccess: () => {
								setHostname("");
								toast.add({ description: t`Domain added. Create the DNS records shown below.` });
							},
							onError: (error) =>
								toast.add({
									type: "error",
									description: getReadableErrorMessage(error, t`Couldn't add the domain. Try again.`),
								}),
						},
					);
				}}
			>
				<div className="grid min-w-[220px] flex-1 gap-1.5">
					<Label htmlFor={id}>
						<Trans>Domain</Trans>
					</Label>
					<Input
						id={id}
						value={hostname}
						placeholder="careers.example.com"
						autoCapitalize="none"
						spellCheck={false}
						disabled={full}
						onChange={(event) => setHostname(event.target.value)}
					/>
				</div>
				<Button type="submit" loading={add.isPending} disabled={full || hostname.trim() === ""}>
					<Icon name="plus" size={18} />
					<Trans>Add domain</Trans>
				</Button>
			</form>
			{full && (
				<p className="text-[13px] text-ink-3">
					<Trans>You've reached the limit. Remove a domain to add another.</Trans>
				</p>
			)}
		</SettingsSection>
	);
}

type Domain = NonNullable<ReturnType<typeof useDomains>["data"]>[number];
type DomainRowProps = { domain: Domain; configured: boolean };

function DomainRow({ domain, configured }: DomainRowProps) {
	const confirm = useConfirm();
	const { recheck, remove } = useDomainMutations();
	const status = statusInfo(domain.status as DomainStatus);
	const failure = failureText(domain.failureReason);
	const [now, setNow] = useState(() => Date.now());
	// Set when the server says the domain was checked a moment ago, whatever our clock thinks.
	const [blockedUntil, setBlockedUntil] = useState(0);
	const wait = Math.max(recheckWaitSeconds(domain.lastCheckedAt, now), Math.ceil((blockedUntil - now) / 1000));
	useEffect(() => {
		if (wait <= 0) return;
		const timer = setTimeout(() => setNow(Date.now()), 1000);
		return () => clearTimeout(timer);
	}, [wait, now]);

	const canRecheck =
		configured && (domain.status === "pending" || domain.status === "verified" || domain.status === "active");
	const showRecords = domain.status === "pending" || domain.status === "verified";

	const onRecheck = () =>
		recheck.mutate(
			{ id: domain.id },
			{
				onError: (error) => {
					if (typeof error === "object" && error !== null && "code" in error && error.code === "TOO_MANY_REQUESTS") {
						const at = Date.now();
						setNow(at);
						setBlockedUntil(at + 60_000);
					} else
						toast.add({
							type: "error",
							description: getReadableErrorMessage(error, t`Couldn't check the domain. Try again.`),
						});
				},
			},
		);

	const onRemove = async () => {
		const confirmed = await confirm(t`Remove ${domain.hostname}?`, {
			description: t`It stops serving your organization right away (other servers within about a minute). Members can still use your address.`,
			confirmText: t`Remove domain`,
		});
		if (!confirmed) return;
		remove.mutate(
			{ id: domain.id },
			{
				onSuccess: () => toast.add({ description: t`Removed ${domain.hostname}` }),
				onError: (error) =>
					toast.add({
						type: "error",
						description: getReadableErrorMessage(error, t`Couldn't remove the domain. Try again.`),
					}),
			},
		);
	};

	return (
		<li className="grid gap-3 rounded-xl p-4 outline outline-line" data-testid="domain-row">
			<div className="flex flex-wrap items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-sm font-medium">{domain.hostname}</span>
				<Badge variant={status.tone} data-testid="domain-status">
					{status.label}
				</Badge>
			</div>
			<p className="text-[13px] text-ink-3">{status.hint}</p>
			{failure && (
				<Alert variant="error">
					<Icon name="warning" />
					<AlertDescription>{failure}</AlertDescription>
				</Alert>
			)}
			{domain.cfSslStatus && (
				<p className="text-[13px] text-ink-2" data-testid="domain-ssl">
					<Trans>Certificate: {domain.cfSslStatus}</Trans>
				</p>
			)}
			{showRecords && (
				<div className="grid gap-2" data-testid="dns-records">
					{domain.records.map((record) => (
						<div key={`${record.type}-${record.name}`} className="grid gap-1 rounded-lg bg-sunken p-3 text-[13px]">
							<div className="flex items-center justify-between gap-2">
								<span className="font-medium">{record.type}</span>
								<CopyButton value={record.value} label={t`Copy ${record.type} value`} />
							</div>
							<span className="break-all text-ink-2">
								<Trans>Name:</Trans> <code>{record.name}</code>
							</span>
							<span className="break-all text-ink-2">
								<Trans>Value:</Trans> <code>{record.value}</code>
							</span>
						</div>
					))}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-2">
				{canRecheck && (
					<Button
						type="button"
						size="sm"
						variant="secondary"
						loading={recheck.isPending}
						disabled={wait > 0}
						onClick={onRecheck}
					>
						<Icon name="arrows-clockwise" size={16} />
						{wait > 0 ? <Trans>Check again in {wait}s</Trans> : <Trans>Check now</Trans>}
					</Button>
				)}
				{domain.status !== "removing" && (
					<Button type="button" size="sm" variant="ghost" loading={remove.isPending} onClick={() => void onRemove()}>
						<Trans>Remove</Trans>
					</Button>
				)}
			</div>
		</li>
	);
}
