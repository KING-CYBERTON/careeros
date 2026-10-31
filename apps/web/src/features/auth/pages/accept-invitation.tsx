import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouteContext, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Button, buttonVariants } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { acceptInvitationPath } from "../invitation";
import { getRoleLabel } from "@/features/organization/roles";
import { authClient } from "@/libs/auth/client";
import { getReadableErrorMessage } from "@/libs/error-message";
import { sessionQueryKey } from "@/libs/root-context";

type AcceptInvitationPageProps = { invitationId: string };

/** The page the invitation email links to: sign in or register first, then accept or decline. */
export function AcceptInvitationPage({ invitationId }: AcceptInvitationPageProps) {
	const { session } = useRouteContext({ strict: false });
	// A guest session cannot receive an invitation addressed to an email, so it signs in or registers first.
	if (!session || session.user.isAnonymous) return <SignedOut invitationId={invitationId} />;
	return <SignedIn invitationId={invitationId} email={session.user.email} emailVerified={session.user.emailVerified} />;
}

function SignedOut({ invitationId }: AcceptInvitationPageProps) {
	const callbackURL = acceptInvitationPath(invitationId);

	return (
		<>
			<div className="space-y-1 text-center">
				<h1 className="text-[30px] leading-9">
					<Trans>You're invited</Trans>
				</h1>
				<p className="text-ink-3">
					<Trans>Sign in or create an account with the email address that received the invitation to join.</Trans>
				</p>
			</div>

			<div className="grid gap-3">
				<Link to="/auth/login" search={{ callbackURL }} className={buttonVariants()}>
					<Trans>Sign in</Trans>
				</Link>
				<Link to="/auth/register" search={{ callbackURL }} className={buttonVariants({ variant: "secondary" })}>
					<Trans>Create an account</Trans>
				</Link>
			</div>
		</>
	);
}

type SignedInProps = AcceptInvitationPageProps & { email: string; emailVerified: boolean };

function SignedIn({ invitationId, email, emailVerified }: SignedInProps) {
	const navigate = useNavigate();
	const router = useRouter();
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const {
		data: invitation,
		error,
		isLoading,
	} = useQuery({
		queryKey: ["organization", "invitation", invitationId],
		retry: false,
		queryFn: async () => {
			const result = await authClient.organization.getInvitation({ query: { id: invitationId } });
			if (result.error || !result.data) throw result.error ?? new Error("Empty response");
			return result.data;
		},
	});

	const finish = async () => {
		await queryClient.invalidateQueries();
		await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
		await router.invalidate();
		await navigate({ to: "/dashboard", replace: true });
	};

	const respond = async (action: "accept" | "decline") => {
		setBusy(true);
		const { error: failure } =
			action === "accept"
				? await authClient.organization.acceptInvitation({ invitationId })
				: await authClient.organization.rejectInvitation({ invitationId });
		if (failure) {
			setBusy(false);
			toast.add({
				type: "error",
				description: getReadableErrorMessage(failure, t`Couldn't answer the invitation. Try again.`),
			});
			return;
		}
		await finish();
	};

	if (isLoading) return <Skeleton className="h-40 rounded-xl" />;

	if (error || !invitation) {
		const code = (error as { code?: string } | null)?.code;
		if (code?.includes("EMAIL_VERIFICATION") || (!emailVerified && code !== "INVITATION_NOT_FOUND"))
			return <VerifyEmail email={email} invitationId={invitationId} />;
		return <InvitationProblem code={code} />;
	}

	return (
		<>
			<div className="space-y-1 text-center">
				<h1 className="text-[30px] leading-9">
					<Trans>Join {invitation.organizationName}</Trans>
				</h1>
				<p className="text-ink-3">
					<Trans>
						{invitation.inviterEmail} invited you to join as {getRoleLabel(invitation.role)}.
					</Trans>
				</p>
			</div>

			<div className="grid gap-3">
				<Button disabled={busy} onClick={() => void respond("accept")}>
					<Icon name="check-circle" size={18} />
					<Trans>Accept</Trans>
				</Button>
				<Button variant="secondary" disabled={busy} onClick={() => void respond("decline")}>
					<Trans>Decline</Trans>
				</Button>
			</div>
		</>
	);
}

type VerifyEmailProps = AcceptInvitationPageProps & { email: string };

function VerifyEmail({ email, invitationId }: VerifyEmailProps) {
	const [sent, setSent] = useState(false);

	const resend = async () => {
		const { error } = await authClient.sendVerificationEmail({
			email,
			callbackURL: acceptInvitationPath(invitationId),
		});
		if (error) {
			toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't send the email. Try again.`) });
			return;
		}
		setSent(true);
	};

	return (
		<>
			<div className="space-y-1 text-center">
				<h1 className="text-[30px] leading-9">
					<Trans>Verify your email first</Trans>
				</h1>
				<p className="text-ink-3">
					<Trans>An invitation can only be accepted once your email address is verified.</Trans>
				</p>
			</div>
			<Alert>
				<Icon name="envelope-simple" />
				<AlertDescription>
					{sent ? (
						<Trans>We sent a verification link to {email}. Open it, then come back to this page.</Trans>
					) : (
						<Trans>Use the verification link we emailed to {email}, or ask for a new one.</Trans>
					)}
				</AlertDescription>
			</Alert>
			<Button variant="secondary" disabled={sent} onClick={() => void resend()}>
				<Trans>Send verification email</Trans>
			</Button>
		</>
	);
}

type InvitationProblemProps = { code: string | undefined };

function InvitationProblem({ code }: InvitationProblemProps) {
	const message =
		code === "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION"
			? t`This invitation was sent to a different email address. Sign in with the address that received it.`
			: t`This invitation has expired, was canceled, or has already been answered. Ask the organization to send a new one.`;

	return (
		<>
			<div className="space-y-1 text-center">
				<h1 className="text-[30px] leading-9">
					<Trans>Invitation unavailable</Trans>
				</h1>
			</div>
			<Alert variant="error">
				<Icon name="warning" />
				<AlertTitle>{message}</AlertTitle>
			</Alert>
			<Link to="/dashboard" className={buttonVariants({ variant: "secondary" })}>
				<Trans>Go to dashboard</Trans>
			</Link>
		</>
	);
}
