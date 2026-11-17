import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { toast } from "@reactive-resume/ui/components/toast";
import { useOrgAdminAccess } from "./queries";
import { SettingsSection } from "@/features/settings/section";
import { getReadableErrorMessage } from "@/libs/error-message";
import { client } from "@/libs/orpc/client";

type Report = Awaited<ReturnType<typeof client.orgAdmin.invitations.dryRun>>;

const statusLabel = (status: string) => {
	switch (status) {
		case "ok":
			return t`Will be invited`;
		case "sent":
			return t`Invited`;
		case "duplicate_in_file":
			return t`Duplicate in the file`;
		case "already_member":
			return t`Already a member`;
		case "already_invited":
			return t`Already invited`;
		case "invalid_email":
			return t`Not a valid email`;
		case "invalid_role":
			return t`Unknown role`;
		case "unknown_cohort":
			return t`Unknown cohort`;
		case "over_seat_limit":
			return t`No seat left`;
		default:
			return t`Couldn't send`;
	}
};

/** CAREEROS (P3-T08): invite many people from a CSV. A dry run shows what would happen; confirming sends. */
export function BulkInviteSection() {
	const access = useOrgAdminAccess();
	const fileId = useId();
	const queryClient = useQueryClient();
	const [file, setFile] = useState<File | null>(null);
	const [report, setReport] = useState<Report | null>(null);
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);

	if (access !== "allowed") return null;

	const check = async () => {
		if (!file) return;
		setBusy(true);
		setConfirmed(false);
		try {
			setReport(await client.orgAdmin.invitations.dryRun({ file }));
		} catch (error) {
			setReport(null);
			toast.add({ type: "error", description: getReadableErrorMessage(error, t`Couldn't read the file. Try again.`) });
		} finally {
			setBusy(false);
		}
	};

	const send = async () => {
		if (!file) return;
		setBusy(true);
		try {
			const result = await client.orgAdmin.invitations.confirm({ file });
			setReport(result);
			setConfirmed(true);
			toast.add({ description: t`Sent ${result.sent} invitations` });
			await queryClient.invalidateQueries();
		} catch (error) {
			toast.add({
				type: "error",
				description: getReadableErrorMessage(error, t`Couldn't send the invitations. Try again.`),
			});
		} finally {
			setBusy(false);
		}
	};

	const okRows = report?.counts.ok ?? 0;

	return (
		<SettingsSection
			title={<Trans>Invite from a CSV file</Trans>}
			description={
				<Trans>
					Columns: email (required), role (member or admin) and cohort (a cohort name). Up to 500 rows and 256 KB.
				</Trans>
			}
		>
			<div className="flex flex-wrap items-end gap-3">
				<div className="grid min-w-[220px] flex-1 gap-1.5">
					<Label htmlFor={fileId}>
						<Trans>CSV file</Trans>
					</Label>
					<Input
						id={fileId}
						type="file"
						accept=".csv,text/csv"
						onChange={(event) => {
							setFile(event.target.files?.[0] ?? null);
							setReport(null);
							setConfirmed(false);
						}}
					/>
				</div>
				<Button variant="secondary" disabled={!file || busy} onClick={() => void check()}>
					<Trans>Check file</Trans>
				</Button>
			</div>
			{report && (
				<>
					<p className="text-sm text-ink-2" data-testid="bulk-invite-summary">
						{confirmed ? (
							<Trans>Sent {report.sent} invitations.</Trans>
						) : (
							<Trans>
								{okRows} of {report.rows.length} rows can be invited.
							</Trans>
						)}
					</p>
					<div className="max-h-80 overflow-auto rounded-xl outline outline-line">
						<table className="w-full min-w-[480px] text-sm" data-testid="bulk-invite-rows">
							<thead className="bg-sunken text-ink-2">
								<tr>
									<th scope="col" className="px-3 py-2 text-start font-medium">
										<Trans>Line</Trans>
									</th>
									<th scope="col" className="px-3 py-2 text-start font-medium">
										<Trans>Email</Trans>
									</th>
									<th scope="col" className="px-3 py-2 text-start font-medium">
										<Trans>Result</Trans>
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-line">
								{report.rows.map((row) => (
									<tr key={`${row.line}-${row.email}`}>
										<td className="px-3 py-2 tabular-nums">{row.line}</td>
										<td className="px-3 py-2">{row.email}</td>
										<td className="px-3 py-2">{statusLabel(row.status)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{!confirmed && (
						<div>
							<Button disabled={busy || okRows === 0} onClick={() => void send()}>
								<Trans>Send {okRows} invitations</Trans>
							</Button>
						</div>
					)}
				</>
			)}
		</SettingsSection>
	);
}
