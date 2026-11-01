import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouteContext, useRouter } from "@tanstack/react-router";
import { Alert, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Button, buttonVariants } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { toast } from "@reactive-resume/ui/components/toast";
import { clearAccountData } from "@/libs/auth/clear-account-data";
import { authClient } from "@/libs/auth/client";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";
import { sessionQueryKey } from "@/libs/root-context";

// CAREEROS (P2-T03): the "join or switch" page of an organization's own address. A signed-in user who is not a member
// of the organization lands here (see `libs/orpc/org-host.ts`) instead of seeing another organization's data.

/** Signed out: nothing to join yet. Signed in: the organization's name, "Join" when it has open signup, and "Sign out". */
export function OrganizationAccessPage() {
	const { session } = useRouteContext({ strict: false });
	if (!session) return <SignedOut />;
	return <SignedIn />;
}

function SignedOut() {
	return (
		<>
			<Heading title={t`Sign in to continue`} />
			<Link to="/auth/login" className={buttonVariants()}>
				<Trans>Sign in</Trans>
			</Link>
		</>
	);
}

type HeadingProps = { title: string; description?: string };

function Heading({ title, description }: HeadingProps) {
	return (
		<div className="space-y-1 text-center">
			<h1 className="text-[30px] leading-9">{title}</h1>
			{description && <p className="text-ink-3">{description}</p>}
		</div>
	);
}

function SignedIn() {
	const navigate = useNavigate();
	const router = useRouter();
	const queryClient = useQueryClient();
	const status = useQuery(orpc.organizationHost.status.queryOptions({ retry: false }));
	const slug = status.data?.slug ?? "";
	// The organization's name comes from its public branding; without one the slug stands in.
	const branding = useQuery(
		orpc.branding.publicBySlug.queryOptions({ input: { slug }, enabled: slug !== "", retry: false }),
	);
	const join = useMutation(orpc.organizationHost.join.mutationOptions());

	const organizationName = branding.data?.appName ?? slug;

	const signOut = async () => {
		await authClient.signOut({
			fetchOptions: {
				onSuccess: () => {
					clearAccountData(queryClient);
					void router.invalidate();
					void navigate({ to: "/auth/login", replace: true });
				},
				onError: ({ error }) => {
					toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't sign out. Try again.`) });
				},
			},
		});
	};

	const joinOrganization = async () => {
		try {
			await join.mutateAsync({});
		} catch (error) {
			toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't join. Try again.`) });
			return;
		}
		await queryClient.invalidateQueries();
		await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
		await router.invalidate();
		await navigate({ to: "/dashboard", replace: true });
	};

	if (status.isLoading || (slug !== "" && branding.isLoading)) return <Skeleton className="h-40 rounded-xl" />;

	// An address that belongs to no organization has nothing to join.
	if (status.error || !status.data) {
		return (
			<>
				<Heading title={t`This address has no organization`} />
				<Link to="/dashboard" className={buttonVariants({ variant: "secondary" })}>
					<Trans>Go to dashboard</Trans>
				</Link>
			</>
		);
	}

	if (status.data.isMember) {
		return (
			<>
				<Heading title={t`You're a member of ${organizationName}`} />
				<Link to="/dashboard" className={buttonVariants()}>
					<Trans>Go to dashboard</Trans>
				</Link>
			</>
		);
	}

	return (
		<>
			<Heading
				title={t`You're not a member of ${organizationName}`}
				description={
					status.data.openSignup
						? t`This account isn't part of ${organizationName} yet. Join it, or sign out and use a different account.`
						: t`This account isn't part of ${organizationName}. Ask its administrator for an invitation, or sign out and use a different account.`
				}
			/>

			{!status.data.openSignup && (
				<Alert>
					<Icon name="lock" />
					<AlertTitle>
						<Trans>{organizationName} is invite only.</Trans>
					</AlertTitle>
				</Alert>
			)}

			<div className="grid gap-3">
				{status.data.openSignup && (
					<Button disabled={join.isPending} onClick={() => void joinOrganization()}>
						<Icon name="check-circle" size={18} />
						<Trans>Join this organization</Trans>
					</Button>
				)}
				<Button variant="secondary" onClick={() => void signOut()}>
					<Trans>Sign out</Trans>
				</Button>
			</div>
		</>
	);
}
