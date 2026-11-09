import { describe, expect, it } from "vite-plus/test";
import { formatInterview, pickContact, pickInterviewDate } from "./fill";

describe("pickInterviewDate", () => {
	const now = new Date("2026-11-10T12:00:00Z");
	const at = (iso: string) => ({ type: "interview", at: new Date(iso) });

	it("takes the next interview still to come", () => {
		const picked = pickInterviewDate(
			[at("2026-11-01T09:00:00Z"), at("2026-11-20T09:00:00Z"), at("2026-11-12T09:00:00Z")],
			now,
		);
		expect(picked?.toISOString()).toBe("2026-11-12T09:00:00.000Z");
	});

	it("takes the most recent one when all are past", () => {
		const picked = pickInterviewDate([at("2026-10-01T09:00:00Z"), at("2026-11-02T09:00:00Z")], now);
		expect(picked?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
	});

	it("ignores other entries, accepts ISO strings and returns null with no interview", () => {
		expect(pickInterviewDate([{ type: "note", at: new Date() }], now)).toBeNull();
		expect(pickInterviewDate([{ type: "interview", at: "2026-11-15T10:00:00Z" }], now)?.toISOString()).toBe(
			"2026-11-15T10:00:00.000Z",
		);
		expect(pickInterviewDate([{ type: "interview", at: "nonsense" }], now)).toBeNull();
	});
});

describe("pickContact", () => {
	it("takes the first contact with a usable address, so the name and the address belong together", () => {
		const contact = pickContact([
			{ name: "No Mail", email: "" },
			{ name: "Sam", email: "sam@acme.test" },
		]);
		expect(contact).toEqual({ name: "Sam", email: "sam@acme.test" });
	});

	it("falls back to the first contact, or none", () => {
		expect(pickContact([{ name: "No Mail", email: "" }])).toEqual({ name: "No Mail", email: "" });
		expect(pickContact([])).toBeNull();
	});
});

describe("formatInterview", () => {
	const at = new Date("2026-11-12T09:30:00Z");

	it("writes the date in the member's time zone and language", () => {
		expect(formatInterview(at, "en", "Africa/Nairobi")).toBe("Thursday, November 12 at 12:30 PM");
		expect(formatInterview(at, "en", "UTC")).toBe("Thursday, November 12 at 9:30 AM");
	});

	it("does not fail on an unknown time zone or language", () => {
		expect(formatInterview(at, "en", "Nowhere/Land")).toBe("Thursday, November 12 at 9:30 AM");
		expect(formatInterview(at, "zz-not-a-locale-!!", "UTC")).toBe("Thursday, November 12 at 9:30 AM");
	});
});
