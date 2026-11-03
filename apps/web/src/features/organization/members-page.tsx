import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import z from "zod";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Badge } from "@reactive-resume/ui/components/badge";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { NativeSelect } from "@reactive-resume/ui/components/native-select";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { organizationKeys, unwrap, useActiveOrganizationId, useMembers, useOrganizations } from "./queries";
import { canChangeRoles, canManageMembers, getRoleLabel } from "./roles";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { useConfirm } from "@/hooks/use-confirm";
import { authClient } from "@/libs/auth/client";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

type InviteRole = "admin" | "member";

/** Members & invites for the active organization. Owners and admins see it; the server checks every action. */
export function MembersSettings() {
	const organizationId = useActiveOrganizationId();
	const { data: organizations } = useOrganizations();
	const { data, isLoading, error } = useMembers();
	const organization = organizations?.find((item) => item.id === organizationId);

	return (
		<>
			<PageHeader
				title={<Trans>Members & invites</Trans>}
				{...(organization ? { description: organization.name } : {})}
			/>
			{isLoading ? (
				<Skeleton className="h-32 rounded-xl" />
			) : error || !data?.me ? (
				<Alert variant="error">
					<Icon name="warning" />
					<AlertTitle>
						<Trans>Couldn't load members</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>You need to belong to an organization to manage its members.</Trans>
					</AlertDescription>
				</Alert>
			) : !canManageMembers(data.me.role) ? (
				<Alert>
					<Icon name="warning-circle" />
					<AlertTitle>
						<Trans>Only owners and admins can manage members</Trans>
					</AlertTitle>
				</Alert>
			) : (
				<>
					<InviteOrNotice />
					<MembersSection myRole={data.me.role} myMemberId={data.me.id} />
					<InvitationsSection />
				</>
			)}
		</>
	);
}

const inviteSchema = z.object({ email: z.email().toLowerCase() });

/** CAREEROS (P3-T02): the plan and seats of the active organization, for the seat note and the personal explanation. */
function useSeats() {
	const { data } = useQuery(orpc.organization.entitlements.queryOptions());
	return data;
}

/**
 * CAREEROS (P3-T02): a personal workspace has one seat, so it cannot invite. The page says so and points to creating an
 * organization (the create-organization screen is Phase 3 backlog). The server refuses the invitation either way.
 */
function InviteOrNotice() {
	const seats = useSeats();
	if (seats?.planId !== "personal") return <InviteSection />;
	return (
		<Alert variant="info" data-testid="personal-workspace-notice">
			<Icon name="user-circle" />
			<AlertTitle>
				<Trans>A personal workspace has one seat</Trans>
			</AlertTitle>
			<AlertDescription>
				<Trans>
					You can't invite people to your personal workspace. To work with a team, create an organization and invite
					them there.
				</Trans>
			</AlertDescription>
		</Alert>
	);
}

function InviteSection() {
	const emailId = useId();
	const roleId = useId();
	const queryClient = useQueryClient();
	const organizationId = useActiveOrganizationId();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<InviteRole>("member");
	const [sending, setSending] = useState(false);

	const submit = async () => {
		const parsed = inviteSchema.safeParse({ email: email.trim() });
		if (!parsed.success) {
			toast.add({ type: "error", description: t`Enter a valid email address.` });
			return;
		}
		setSending(true);
		const { error } = await authClient.organization.inviteMember({ email: parsed.data.email, role });
		setSending(false);
		if (error) {
			toast.add({
				type: "error",
				description: getReadableErrorMessage(error, t`Couldn't send the invitation. Try again.`),
			});
			return;
		}
		setEmail("");
		toast.add({ description: t`Invitation sent to ${parsed.data.email}` });
		await queryClient.invalidateQueries({ queryKey: organizationKeys.invitations(organizationId) });
		await queryClient.invalidateQueries({ queryKey: orpc.organization.entitlements.key() });
	};

	const seats = useSeats();

	return (
		<SettingsSection
			title={<Trans>Invite someone</Trans>}
			description={
				seats && seats.seatLimit !== null ? (
					<Trans>
						They get an email with a link that is valid for 7 days. {seats.seatsUsed} of {seats.seatLimit} seats are
						used, counting pending invitations.
					</Trans>
				) : (
					<Trans>They get an email with a link that is valid for 7 days.</Trans>
				)
			}
		>
			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div className="grid min-w-[220px] flex-1 gap-1.5">
					<Label htmlFor={emailId}>
						<Trans>Email address</Trans>
					</Label>
					<Input
						id={emailId}
						type="email"
						autoComplete="off"
						placeholder="name@example.com"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
					/>
				</div>
				<div className="grid w-36 gap-1.5">
					<Label htmlFor={roleId}>
						<Trans>Role</Trans>
					</Label>
					<NativeSelect id={roleId} value={role} onChange={(event) => setRole(event.target.value as InviteRole)}>
						<option value="member">{getRoleLabel("member")}</option>
						<option value="admin">{getRoleLabel("admin")}</option>
					</NativeSelect>
				</div>
				<Button type="submit" disabled={sending || email.trim() === ""}>
					<Icon name="user-plus" size={18} />
					<Trans>Send invitation</Trans>
				</Button>
			</form>
		</SettingsSection>
	);
}

type MembersSectionProps = { myRole: string; myMemberId: string };

function MembersSection({ myRole, myMemberId }: MembersSectionProps) {
	const queryClient = useQueryClient();
	const confirm = useConfirm();
	const organizationId = useActiveOrganizationId();
	const { data } = useMembers();
	const members = data?.members ?? [];
	const refresh = async () => {
		await queryClient.invalidateQueries({ queryKey: organizationKeys.members(organizationId) });
		// CAREEROS (P3-T02): a removed member frees a seat at once
		await queryClient.invalidateQueries({ queryKey: orpc.organization.entitlements.key() });
	};

	const changeRole = async (memberId: string, role: InviteRole) => {
		const { error } = await authClient.organization.updateMemberRole({ memberId, role });
		if (error)
			toast.add({
				type: "error",
				description: getReadableErrorMessage(error, t`Couldn't change the role. Try again.`),
			});
		await refresh();
	};

	const remove = async (memberId: string, name: string) => {
		const confirmed = await confirm(t`Remove ${name}?`, {
			description: t`They lose access to this organization right away.`,
			confirmText: t`Remove member`,
		});
		if (!confirmed) return;
		const { error } = await authClient.organization.removeMember({ memberIdOrEmail: memberId });
		if (error) {
			toast.add({
				type: "error",
				description: getReadableErrorMessage(error, t`Couldn't remove the member. Try again.`),
			});
			return;
		}
		toast.add({ description: t`Removed ${name}` });
		await refresh();
	};

	return (
		<SettingsSection title={<Trans>Members</Trans>}>
			<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line">
				{members.map((member) => {
					const isMe = member.id === myMemberId;
					const name = member.user.name;
					// Owners cannot be removed or demoted here; ownership transfer arrives with a later phase.
					const removable = canManageMembers(myRole) && !isMe && member.role !== "owner";
					return (
						<li key={member.id} className="flex flex-wrap items-center gap-3 p-3" data-testid="member-row">
							<div className="grid min-w-0 flex-1">
								<span className="truncate text-sm font-medium">
									{name}
									{isMe && (
										<span className="ms-1.5 font-normal text-ink-3">
											<Trans>(you)</Trans>
										</span>
									)}
								</span>
								<span className="truncate text-[13px] text-ink-3">{member.user.email}</span>
							</div>
							{canChangeRoles(myRole) && !isMe && member.role !== "owner" ? (
								<NativeSelect
									aria-label={t`Role of ${name}`}
									className="w-32"
									value={member.role}
									onChange={(event) => void changeRole(member.id, event.target.value as InviteRole)}
								>
									<option value="member">{getRoleLabel("member")}</option>
									<option value="admin">{getRoleLabel("admin")}</option>
								</NativeSelect>
							) : (
								<Badge variant={member.role === "owner" ? "accent" : "neutral"}>{getRoleLabel(member.role)}</Badge>
							)}
							{removable && (
								<Button
									size="sm"
									variant="ghost"
									className="text-danger-text hover:bg-danger-soft"
									aria-label={t`Remove ${name}`}
									onClick={() => void remove(member.id, name)}
								>
									<Trans>Remove</Trans>
								</Button>
							)}
						</li>
					);
				})}
			</ul>
		</SettingsSection>
	);
}

function InvitationsSection() {
	const queryClient = useQueryClient();
	const organizationId = useActiveOrganizationId();
	const { data: invitations = [], isLoading } = useQuery({
		queryKey: organizationKeys.invitations(organizationId),
		enabled: organizationId !== null,
		queryFn: async () => unwrap(await authClient.organization.listInvitations()),
		select: (items) => items.filter((invitation) => invitation.status === "pending"),
	});

	const cancel = async (invitationId: string) => {
		const { error } = await authClient.organization.cancelInvitation({ invitationId });
		if (error) {
			toast.add({
				type: "error",
				description: getReadableErrorMessage(error, t`Couldn't cancel the invitation. Try again.`),
			});
			return;
		}
		await queryClient.invalidateQueries({ queryKey: organizationKeys.invitations(organizationId) });
		// CAREEROS (P3-T02): a cancelled invitation frees its seat at once
		await queryClient.invalidateQueries({ queryKey: orpc.organization.entitlements.key() });
	};

	return (
		<SettingsSection title={<Trans>Pending invitations</Trans>}>
			{isLoading ? (
				<Skeleton className="h-14 rounded-xl" />
			) : invitations.length === 0 ? (
				<p className="rounded-xl border border-dashed border-line-2 p-4 text-sm text-ink-2">
					<Trans>No pending invitations.</Trans>
				</p>
			) : (
				<ul className="divide-y divide-line overflow-hidden rounded-xl outline outline-line">
					{invitations.map((invitation) => (
						<li key={invitation.id} className="flex flex-wrap items-center gap-3 p-3" data-testid="invitation-row">
							<span className="min-w-0 flex-1 truncate text-sm">{invitation.email}</span>
							<Badge>{getRoleLabel(invitation.role)}</Badge>
							<Button
								size="sm"
								variant="ghost"
								aria-label={t`Cancel invitation for ${invitation.email}`}
								onClick={() => void cancel(invitation.id)}
							>
								<Trans>Cancel</Trans>
							</Button>
						</li>
					))}
				</ul>
			)}
		</SettingsSection>
	);
}
