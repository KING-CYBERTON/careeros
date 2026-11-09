import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { Icon } from "@reactive-resume/ui/components/icon";
import { notify } from "./shared";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsSection } from "@/features/settings/section";
import { getReadableErrorMessage } from "@/libs/error-message";
import { orpc } from "@/libs/orpc/client";

// CAREEROS (P6-T02): the console's "Send test email". It mails the signed-in admin's own address with a fixed message and
// shows what the provider answered: queued, or the error code. There is no recipient field on purpose.

type TestResult = {
	provider: "plunk" | "smtp" | "log";
	outcome: "queued" | "suppressed" | "logged" | "failed";
	code?: string | undefined;
	status?: number | undefined;
};

type ResultNoticeProps = { result: TestResult };
function ResultNotice({ result }: ResultNoticeProps) {
	if (result.outcome === "queued")
		return (
			<Alert variant="success" data-testid="email-test-result">
				<Icon name="check-circle" />
				<AlertTitle>
					<Trans>Queued</Trans>
				</AlertTitle>
				<AlertDescription>
					<Trans>The provider accepted the message. It should arrive in your inbox shortly.</Trans>
				</AlertDescription>
			</Alert>
		);
	if (result.outcome === "failed")
		return (
			<Alert variant="error" data-testid="email-test-result">
				<Icon name="warning" />
				<AlertTitle>
					<Trans>The provider refused the message</Trans>
				</AlertTitle>
				<AlertDescription>
					{result.status
						? t`Error code: ${result.code ?? "unknown"} (HTTP ${result.status})`
						: t`Error code: ${result.code ?? "unknown"}`}
				</AlertDescription>
			</Alert>
		);
	return (
		<Alert variant="warn" data-testid="email-test-result">
			<Icon name="warning-circle" />
			<AlertTitle>
				{result.outcome === "suppressed" ? (
					<Trans>Your address is on the suppression list</Trans>
				) : (
					<Trans>Nothing was sent</Trans>
				)}
			</AlertTitle>
			<AlertDescription>
				{result.outcome === "suppressed" ? (
					<Trans>The address of your account bounced or complained before, so it is not mailed again.</Trans>
				) : (
					<Trans>No email provider is configured on this server, so the message was only logged.</Trans>
				)}
			</AlertDescription>
		</Alert>
	);
}

export function EmailPage() {
	const send = useMutation(
		orpc.admin.email.sendTest.mutationOptions({
			onError: (error: unknown) => notify.error(getReadableErrorMessage(error, t`The test email could not be sent.`)),
		}),
	);

	return (
		<div className="grid gap-6">
			<PageHeader
				title={<Trans>Email</Trans>}
				description={<Trans>Check that the platform can deliver email.</Trans>}
			/>
			<SettingsSection
				title={<Trans>Send test email</Trans>}
				description={
					<Trans>Sends a fixed message to the address of your own account, and shows the provider's answer.</Trans>
				}
			>
				<div className="grid gap-4">
					<div>
						<Button
							type="button"
							data-testid="email-test-send"
							disabled={send.isPending}
							onClick={() => send.mutate({})}
						>
							<Trans>Send test email</Trans>
						</Button>
					</div>
					{send.data && <ResultNotice result={send.data} />}
				</div>
			</SettingsSection>
		</div>
	);
}
