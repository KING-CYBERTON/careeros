import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_TEMPLATES } from "./built-ins";
import { firstNameOf, renderSubject, renderTemplate, variablesIn, VARIABLE_NAMES } from "./render";

describe("renderTemplate", () => {
	it("fills every known variable", () => {
		const values = {
			firstName: "Amina",
			fullName: "Amina Otieno",
			company: "Acme",
			role: "Designer",
			contactName: "Sam",
			interviewDate: "Tue 10 Nov, 14:00",
			myEmail: "amina@example.test",
		};
		const text = VARIABLE_NAMES.map((name) => `{{${name}}}`).join("|");
		expect(renderTemplate(text, values)).toBe(Object.values(values).join("|"));
	});

	it("keeps unknown variables exactly as typed", () => {
		expect(renderTemplate("Hi {{nickname}} and {{ company }} {{COMPANY}}", { company: "Acme" })).toBe(
			"Hi {{nickname}} and Acme {{COMPANY}}",
		);
	});

	it("turns a missing, null or blank value into a visible placeholder", () => {
		expect(renderTemplate("{{company}} {{role}} {{contactName}}", { role: "  ", contactName: null })).toBe(
			"[company] [role] [contactName]",
		);
	});

	it("is a single pass: a value that looks like a variable is not expanded", () => {
		expect(renderTemplate("{{company}}", { company: "{{role}}", role: "Designer" })).toBe("{{role}}");
	});

	it("does not interpret HTML or expressions", () => {
		const out = renderTemplate("{{company}} ${1+1} {{constructor}} {{__proto__}} <b>x</b>", {
			company: "<img src=x onerror=alert(1)>",
		});
		expect(out).toBe("<img src=x onerror=alert(1)> ${1+1} {{constructor}} {{__proto__}} <b>x</b>");
	});

	it("does not read values that are not own, known variables", () => {
		expect(renderTemplate("{{toString}} {{hasOwnProperty}}", {})).toBe("{{toString}} {{hasOwnProperty}}");
	});

	it("removes control characters from a value and normalises its line breaks", () => {
		expect(renderTemplate("{{company}}", { company: "Ac\u0000me\r\nInc" })).toBe("Acme\nInc");
	});
});

describe("renderSubject", () => {
	it("makes the subject one line", () => {
		expect(renderSubject("Re: {{role}}\n{{company}}", { role: "Lead\r\nDesigner", company: "Acme" })).toBe(
			"Re: Lead Designer Acme",
		);
	});
});

describe("variablesIn", () => {
	it("lists the known variables once, in order", () => {
		expect(variablesIn("{{role}} {{nope}} {{company}} {{role}}")).toEqual(["role", "company"]);
	});
});

describe("firstNameOf", () => {
	it("takes the first word", () => {
		expect(firstNameOf("  Amina  Otieno ")).toBe("Amina");
		expect(firstNameOf("")).toBe("");
		expect(firstNameOf(null)).toBe("");
	});
});

describe("the built-in templates", () => {
	it("has one per kind except custom, with only known variables", () => {
		expect(BUILT_IN_TEMPLATES.map((item) => item.kind).sort()).toEqual([
			"follow_up",
			"negotiation",
			"networking",
			"thank_you",
		]);
		for (const item of BUILT_IN_TEMPLATES) {
			const all = `${item.subject}\n${item.body}`;
			const used = [...all.matchAll(/\{\{\s*([A-Za-z0-9]+)\s*\}\}/g)].map((match) => match[1]);
			expect(used.length).toBeGreaterThan(0);
			for (const name of used) expect(VARIABLE_NAMES as readonly string[]).toContain(name);
			expect(item.id).toBe(`builtin:${item.kind}`);
		}
	});

	it("fills in from an application with no contact, with visible placeholders", () => {
		const thankYou = BUILT_IN_TEMPLATES.find((item) => item.kind === "thank_you");
		const out = renderSubject(thankYou?.subject ?? "", { company: "Acme" });
		expect(out).toBe("Thank you for meeting with me on [interviewDate]");
	});
});
