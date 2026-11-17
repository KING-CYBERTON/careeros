import { Trans } from "@lingui/react/macro";
import { Link, Outlet, useRouteContext } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Icon } from "@reactive-resume/ui/components/icon";
import { isPlatformAdmin, NotFoundPage } from "./shared";

// CAREEROS (P3-T07): the Super Admin console's frame. A signed-in user who is not an admin sees the same page as an
// unknown address. An admin without two-factor authentication sees how to turn it on: the server answers 403
// TWO_FACTOR_REQUIRED until then, so this screen only explains. None of this is the guard; the database is.

export function AdminLayout() {
	const { session } = useRouteContext({ from: "/admin" });
	if (!isPlatformAdmin((session.user as { role?: string | null }).role)) return <NotFoundPage />;

	if (!(session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled)
		return (
			<div className="mx-auto grid max-w-xl gap-4 px-4 py-16" data-testid="admin-two-factor-required">
				<h1 className="font-display text-[30px] leading-9 font-medium">
					<Trans>Two-factor authentication is required</Trans>
				</h1>
				<Alert variant="warn">
					<Icon name="warning-circle" />
					<AlertTitle>
						<Trans>Turn it on to open the console</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							The console can change any organization. It stays closed until your account has two-factor authentication.
						</Trans>
					</AlertDescription>
				</Alert>
				<Link
					to="/dashboard/settings/authentication"
					className="text-sm font-medium text-accent-text underline-offset-4 hover:underline"
				>
					<Trans>Set up two-factor authentication</Trans>
				</Link>
			</div>
		);

	return (
		<div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6" data-testid="admin-console">
			<nav aria-label="Console" className="flex flex-wrap items-center gap-1 border-b border-line pb-3 text-sm">
				<span className="me-3 font-semibold">
					<Trans>Console</Trans>
				</span>
				{(
					[
						["/admin/organizations", <Trans key="o">Organizations</Trans>],
						["/admin/metrics", <Trans key="m">Metrics</Trans>],
						["/admin/announcements", <Trans key="a">Announcements</Trans>],
						["/admin/audit", <Trans key="l">Audit log</Trans>],
						// CAREEROS (P6-T02)
						["/admin/email", <Trans key="e">Email</Trans>],
					] as const
				).map(([to, label]) => (
					<Link
						key={to}
						to={to}
						className="rounded-md px-3 py-1.5 text-ink-2 hover:bg-hover data-[status=active]:bg-sunken data-[status=active]:text-ink"
					>
						{label}
					</Link>
				))}
				<Link to="/dashboard" className="ms-auto text-ink-3 hover:text-ink">
					<Trans>Back to the app</Trans>
				</Link>
			</nav>
			<Outlet />
		</div>
	);
}
