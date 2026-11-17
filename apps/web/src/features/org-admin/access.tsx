import type { ReactNode } from "react";
import { Trans } from "@lingui/react/macro";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Icon } from "@reactive-resume/ui/components/icon";
import { Skeleton } from "@reactive-resume/ui/components/skeleton";
import { useOrgAdminAccess } from "./queries";

type RequireOrgAdminProps = { children: ReactNode };

/**
 * CAREEROS (P3-T08): the Org Admin pages are for owners and admins of an organization, not of a personal workspace.
 * Anyone else sees a note instead of the page. This is a courtesy; every API call checks the same rule on the server.
 */
export function RequireOrgAdmin({ children }: RequireOrgAdminProps) {
	const access = useOrgAdminAccess();
	if (access === "loading") return <Skeleton className="h-40 rounded-xl" />;
	if (access === "denied")
		return (
			<Alert data-testid="org-admin-denied">
				<Icon name="warning-circle" />
				<AlertTitle>
					<Trans>Only owners and admins of an organization can open this page</Trans>
				</AlertTitle>
				<AlertDescription>
					<Trans>A personal workspace has no admin area. Create an organization to manage a team.</Trans>
				</AlertDescription>
			</Alert>
		);
	return children;
}
