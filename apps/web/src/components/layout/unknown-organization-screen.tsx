// CAREEROS (P2-T02, P2-T03 Q92): shown on an address that looks like an organization's but belongs to none.
import { Trans } from "@lingui/react/macro";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Icon } from "@reactive-resume/ui/components/icon";

/** Neutral on purpose: it names no product and no organization, because there is no organization to name. */
export function UnknownOrganizationScreen() {
	return (
		<main className="mx-auto flex h-svh max-w-md flex-col items-center justify-center gap-y-4 px-4">
			<Alert>
				<Icon name="warning" size={16} />
				<AlertTitle>
					<Trans>This address isn't set up yet</Trans>
				</AlertTitle>
				<AlertDescription>
					<Trans>Check the address, or ask the person who gave it to you for the right link.</Trans>
				</AlertDescription>
			</Alert>
		</main>
	);
}
