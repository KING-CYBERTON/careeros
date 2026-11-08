import type { InviteCsvRow } from "./csv";
import z from "zod";

// CAREEROS (P3-T08, phase plan D8): what happens to each row of a bulk invitation list. Pure: the service gathers the
// facts (members, pending invitations, cohorts, free seats) and this file decides. The same function runs for the dry
// run and again for the confirm call, so a row is never sent on the strength of an earlier answer alone.

export const INVITE_ROW_STATUSES = [
	"ok",
	"duplicate_in_file",
	"already_member",
	"already_invited",
	"invalid_email",
	"invalid_role",
	"unknown_cohort",
	"over_seat_limit",
	// Only on a confirm call: the row was ok, but sending it failed (see the service).
	"send_failed",
] as const;
export type InviteRowStatus = (typeof INVITE_ROW_STATUSES)[number];

/** Roles a bulk list may grant. `owner` is never one of them. */
export const BULK_INVITE_ROLES = ["member", "admin"] as const;
export type BulkInviteRole = (typeof BULK_INVITE_ROLES)[number];

export type InviteRowResult = {
	line: number;
	email: string;
	role: BulkInviteRole | null;
	cohort: string | null;
	cohortId: string | null;
	status: InviteRowStatus;
};

export type InviteFacts = {
	/** Lowercase emails of the organization's members. */
	memberEmails: ReadonlySet<string>;
	/** Lowercase emails with a pending, unexpired invitation. */
	invitedEmails: ReadonlySet<string>;
	/** Active (not archived) cohorts by lowercase name. */
	cohortsByName: ReadonlyMap<string, string>;
	/** Seats still free (limit minus members and pending invitations); null means unlimited. */
	freeSeats: number | null;
};

const emailSchema = z.email().max(254);

/** The result of every row, in file order. Rows that are ok take seats in order until none are free. */
export function evaluateInviteRows(rows: readonly InviteCsvRow[], facts: InviteFacts): InviteRowResult[] {
	const seen = new Set<string>();
	let seatsLeft = facts.freeSeats;
	return rows.map((row): InviteRowResult => {
		const email = row.email.toLowerCase();
		const roleName = row.role === "" ? "member" : row.role.toLowerCase();
		const result = (
			status: InviteRowStatus,
			extra: Partial<Pick<InviteRowResult, "role" | "cohortId">> = {},
		): InviteRowResult => ({
			line: row.line,
			email,
			role: null,
			cohort: row.cohort === "" ? null : row.cohort,
			cohortId: null,
			status,
			...extra,
		});

		if (!emailSchema.safeParse(email).success) return result("invalid_email");
		if (seen.has(email)) return result("duplicate_in_file");
		seen.add(email);
		if (!(BULK_INVITE_ROLES as readonly string[]).includes(roleName)) return result("invalid_role");
		const role = roleName as BulkInviteRole;
		if (facts.memberEmails.has(email)) return result("already_member", { role });
		if (facts.invitedEmails.has(email)) return result("already_invited", { role });
		let cohortId: string | null = null;
		if (row.cohort !== "") {
			cohortId = facts.cohortsByName.get(row.cohort.toLowerCase()) ?? null;
			if (cohortId === null) return result("unknown_cohort", { role });
		}
		if (seatsLeft !== null) {
			if (seatsLeft <= 0) return result("over_seat_limit", { role, cohortId });
			seatsLeft--;
		}
		return result("ok", { role, cohortId });
	});
}

export function summarizeInviteRows(results: readonly InviteRowResult[]): Record<InviteRowStatus, number> {
	const counts = Object.fromEntries(INVITE_ROW_STATUSES.map((status) => [status, 0])) as Record<
		InviteRowStatus,
		number
	>;
	for (const result of results) counts[result.status]++;
	return counts;
}
