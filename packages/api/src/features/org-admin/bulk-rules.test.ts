import { describe, expect, it } from "vite-plus/test";
import { evaluateInviteRows, summarizeInviteRows, type InviteFacts } from "./bulk-rules";

const facts = (overrides: Partial<InviteFacts> = {}): InviteFacts => ({
	memberEmails: new Set(["member@example.test"]),
	invitedEmails: new Set(["invited@example.test"]),
	cohortsByName: new Map([["spring", "cohort-spring"]]),
	freeSeats: null,
	...overrides,
});
const row = (line: number, email: string, role = "", cohort = "") => ({ line, email, role, cohort });
const statuses = (results: { status: string }[]) => results.map((result) => result.status);

describe("evaluateInviteRows", () => {
	it("marks a valid row ok with the default role and no cohort", () => {
		expect(evaluateInviteRows([row(2, "New@Example.test")], facts())).toEqual([
			{ line: 2, email: "new@example.test", role: "member", cohort: null, cohortId: null, status: "ok" },
		]);
	});

	it("rejects an invalid email, whatever else the row says", () => {
		const results = evaluateInviteRows(
			[row(2, "not-an-email", "owner"), row(3, ""), row(4, "=1+1@x"), row(5, `${"a".repeat(250)}@example.test`)],
			facts(),
		);
		expect(statuses(results)).toEqual(["invalid_email", "invalid_email", "invalid_email", "invalid_email"]);
	});

	it("never grants owner, and rejects any role other than member or admin", () => {
		const results = evaluateInviteRows(
			[row(2, "a@example.test", "owner"), row(3, "b@example.test", "Admin"), row(4, "c@example.test", "root")],
			facts(),
		);
		expect(statuses(results)).toEqual(["invalid_role", "ok", "invalid_role"]);
		expect(results[1]?.role).toBe("admin");
	});

	it("flags the second occurrence of an address, case-insensitively, and keeps the first", () => {
		const results = evaluateInviteRows(
			[row(2, "a@example.test"), row(3, "A@EXAMPLE.test"), row(4, "b@example.test")],
			facts(),
		);
		expect(statuses(results)).toEqual(["ok", "duplicate_in_file", "ok"]);
	});

	it("flags members and pending invitations", () => {
		const results = evaluateInviteRows([row(2, "MEMBER@example.test"), row(3, "invited@example.test")], facts());
		expect(statuses(results)).toEqual(["already_member", "already_invited"]);
	});

	it("resolves a cohort by name, case-insensitively, and flags an unknown one", () => {
		const results = evaluateInviteRows(
			[row(2, "a@example.test", "", "SPRING"), row(3, "b@example.test", "", "Autumn")],
			facts(),
		);
		expect(results[0]).toMatchObject({ status: "ok", cohortId: "cohort-spring", cohort: "SPRING" });
		expect(results[1]).toMatchObject({ status: "unknown_cohort", cohortId: null });
	});

	it("gives seats to the ok rows in file order and reports the rest, which are not sent", () => {
		const rows = [
			row(2, "a@example.test"),
			row(3, "bad"),
			row(4, "member@example.test"),
			row(5, "b@example.test"),
			row(6, "c@example.test"),
		];
		const results = evaluateInviteRows(rows, facts({ freeSeats: 2 }));
		expect(statuses(results)).toEqual(["ok", "invalid_email", "already_member", "ok", "over_seat_limit"]);
	});

	it("reports every row over the limit when no seat is free", () => {
		const results = evaluateInviteRows([row(2, "a@example.test"), row(3, "b@example.test")], facts({ freeSeats: 0 }));
		expect(statuses(results)).toEqual(["over_seat_limit", "over_seat_limit"]);
	});

	it("counts every status", () => {
		const results = evaluateInviteRows([row(2, "a@example.test"), row(3, "a@example.test"), row(4, "x")], facts());
		expect(summarizeInviteRows(results)).toMatchObject({
			ok: 1,
			duplicate_in_file: 1,
			invalid_email: 1,
			over_seat_limit: 0,
		});
	});
});
