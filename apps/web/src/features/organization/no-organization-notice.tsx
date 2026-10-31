import { Trans } from "@lingui/react/macro";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Icon } from "@reactive-resume/ui/components/icon";
import { useOrganizations } from "./queries";

/** A user who belongs to no organization has nothing to act in until they accept an invitation. */
export function NoOrganizationNotice() {
	const { data: organizations } = useOrganizations();
	if (!organizations || organizations.length > 0) return null;

	return (
		<div className="px-4 pt-4">
			<Alert variant="info">
				<Icon name="envelope-simple" />
				<AlertTitle>
					<Trans>Accept your invitation</Trans>
				</AlertTitle>
				<AlertDescription>
					<Trans>
						You aren't a member of any organization yet. Open the invitation link in the email you received to join one.
					</Trans>
				</AlertDescription>
			</Alert>
		</div>
	);
}
