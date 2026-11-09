import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { render } from "react-email";
import { renewalReminderCopy } from "./billing-strings";
import { RenewalReminderEmail } from "./templates/auth";

// CAREEROS (P3-T05): the renewal reminder words and template.
const url = "https://careeros.example.test/dashboard/settings/billing";

describe("renewal reminder copy", () => {
	it("names the organization, the product and the end date, differently for three days out and the last day", () => {
		const three = renewalReminderCopy("three_days", {
			appName: "Acme Careers",
			organizationName: "Acme",
			endDate: "12 November 2026",
		});
		const last = renewalReminderCopy("last_day", {
			appName: "Acme Careers",
			organizationName: "Acme",
			endDate: "12 November 2026",
		});
		expect(three.subject).toBe("Your Acme Careers plan ends on 12 November 2026");
		expect(last.subject).toBe("Your Acme Careers plan ends today");
		expect(three.intro).toContain("Acme");
		expect(three.intro).toContain("does not renew by itself");
		expect(last.heading).not.toBe(three.heading);
		for (const copy of [three, last]) expect(Object.values(copy).join(" ")).not.toMatch(/\{\w+\}/);
	});

	it("uses the platform name when there is no brand and cleans line breaks out of names", () => {
		const copy = renewalReminderCopy("last_day", {
			organizationName: "Evil\r\nBcc: x@example.test",
			endDate: "1 January 2027",
		});
		expect(copy.subject).toContain("CareerOS");
		expect(copy.intro).not.toMatch(/[\r\n]/);
	});
});

describe("renewal reminder email", () => {
	const copy = renewalReminderCopy("three_days", { organizationName: "Acme", endDate: "12 November 2026" });

	it("renders with no brand as the platform default, with the pay link", async () => {
		const html = await render(createElement(RenewalReminderEmail, { url, copy }));
		expect(html).toContain("CareerOS");
		expect(html).toContain("Pay for the next period");
		expect(html).toContain(url);
		expect(html).not.toContain("<img");
	});

	it("renders a brand's name and colours", async () => {
		const brand = { appName: "Acme Careers", primaryColor: "#112233", primaryForeground: "#ffffff" };
		const branded = renewalReminderCopy("three_days", {
			appName: "Acme Careers",
			organizationName: "Acme",
			endDate: "12 November 2026",
		});
		const html = await render(createElement(RenewalReminderEmail, { url, copy: branded, brand }));
		expect(html).toContain("Acme Careers");
		expect(html).not.toContain("CareerOS");
		expect(html).toContain("#112233");
	});
});
