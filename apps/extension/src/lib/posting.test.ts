import { afterEach, describe, expect, it } from "vite-plus/test";
// @vitest-environment happy-dom
import { MAX_DESCRIPTION_CHARS, MAX_FIELD_CHARS } from "@careeros/job-posting";
import { findJobPosting, htmlToText, parsePosting, salaryOf } from "./posting";
import { fixtures, hostile, HOSTILE_INJECTION, type Fixture } from "./posting.fixtures";
import { readPageInTab, readRawPage, type RawPage } from "./reader";

// P5-T03: the reader (run against real DOM documents, as the browser runs it) and the parser, on fictional pages.

type HappyWindow = Window & { happyDOM: { setURL(url: string): void } };

function open(fixture: { url: string; html: string }) {
	(window as unknown as HappyWindow).happyDOM.setURL(fixture.url);
	document.open();
	document.write(fixture.html);
	document.close();
}

function read(fixture: { url: string; html: string }): RawPage {
	open(fixture);
	return readPageInTab();
}

const byName = (name: string): Fixture => {
	const found = fixtures.find((fixture) => fixture.name.startsWith(name));
	if (!found) throw new Error(`no fixture ${name}`);
	return found;
};
const clipOf = (name: string) => parsePosting(read(byName(name)));

afterEach(() => {
	delete (globalThis as { pwned?: boolean }).pwned;
});

/** Strings, lists of strings and nothing else: no HTML node, no function, no number-keyed surprise. */
function isPlainData(value: unknown): boolean {
	if (typeof value === "string") return true;
	if (Array.isArray(value)) return value.every((item) => typeof item === "string");
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).every(isPlainData);
}

describe("the reader", () => {
	it("returns plain data for every fixture page, and it survives a round trip through JSON", () => {
		for (const fixture of [...fixtures, hostile]) {
			const raw = read(fixture);
			expect(isPlainData(raw), fixture.name).toBe(true);
			expect(JSON.parse(JSON.stringify(raw)), fixture.name).toEqual(raw);
			expect(readRawPage(raw), fixture.name).toEqual(raw);
		}
	});

	it("changes nothing on the page", () => {
		open(byName("JSON-LD: a single object"));
		const before = document.documentElement.outerHTML;
		readPageInTab();
		expect(document.documentElement.outerHTML).toBe(before);
	});

	it("is a self-contained function: serialized and run on its own it gives the same answer", () => {
		open(byName("no JSON-LD: Open Graph"));
		// This is what chrome.scripting does: it sends the source text and runs it in the page.
		const standalone = new Function(`return (${readPageInTab.toString()})()`) as () => RawPage;
		expect(standalone()).toEqual(readPageInTab());
	});

	it("reads the raw JSON-LD, the Open Graph values, the first heading and the main text", () => {
		const raw = read(byName("no JSON-LD: Open Graph"));
		expect(raw).toMatchObject({
			url: "https://jobs.example.test/p/42?utm_campaign=x&utm_medium=y",
			title: "Careers",
			ogTitle: "Customer Success Manager",
			ogSiteName: "Cedar Software",
			h1: "Something else",
			jsonLd: [],
		});
		expect(raw.mainText).toContain("Help customers succeed.");
		// The navigation and the footer are outside <main>.
		expect(raw.mainText).not.toContain("Navigation");
		expect(raw.mainText).not.toContain("Cookies");
	});

	it("takes the largest of several main blocks", () => {
		const raw = read(byName("no JSON-LD: first heading"));
		expect(raw.mainText).toContain("Keep the trucks moving.");
		expect(raw.mainText).not.toBe("Short.");
	});
});

describe("clipping a page with JobPosting JSON-LD", () => {
	it("fills every field from a single object, and the tab address is the default posting address", () => {
		const clip = clipOf("JSON-LD: a single object");
		expect(clip.origin).toBe("page");
		expect(clip.fields).toEqual({
			title: "Senior Backend Engineer",
			company: "Aurora Analytics",
			location: "Nairobi, Nairobi County, KE",
			salary: "KES 250,000 - 400,000 per month",
			// https only, no fragment, no tracking; what identifies the page stays.
			url: "https://careers.example.test/jobs/senior-backend-engineer?gh_jid=77",
			description:
				"Full time · Posted 2026-11-01 · Apply by 2026-12-15\n\nBuild reliable services.\nTypeScript\nPostgreSQL\n\nR&D culture.",
		});
	});

	it("finds the posting in an array of objects", () => {
		const clip = clipOf("JSON-LD: an array");
		expect(clip.origin).toBe("page");
		expect(clip.fields).toMatchObject({ title: "Platform Engineer", company: "Aurora Analytics" });
	});

	it("finds the posting in @graph", () => {
		const clip = clipOf("JSON-LD: @graph");
		expect(clip.origin).toBe("page");
		expect(clip.fields.title).toBe("Data Engineer");
	});

	it("accepts @type given as an array", () => {
		expect(clipOf("JSON-LD: @type given as an array").fields.title).toBe("Site Reliability Engineer");
	});

	it("reads a remote job as Remote", () => {
		const { fields } = clipOf("JSON-LD: a remote job");
		expect(fields.location).toBe("Remote");
		expect(fields.salary).toBe("");
	});

	it("reads a salary range with its unit", () => {
		expect(clipOf("JSON-LD: a salary range").fields.salary).toBe("USD 18.5 - 24 per hour");
	});

	it("ignores malformed blocks and still finds the valid one after them", () => {
		const clip = clipOf("JSON-LD: malformed blocks next to a valid one");
		expect(clip.origin).toBe("page");
		expect(clip.fields.title).toBe("Valid After Broken");
	});

	it("falls back to heuristics when every block is malformed, without failing", () => {
		const clip = clipOf("JSON-LD: only malformed");
		expect(clip.origin).toBe("guess");
		expect(clip.fields).toMatchObject({ title: "Product Designer", company: "Borealis Studio" });
		expect(clip.fields.description).toContain("Design things people use every day.");
	});

	it("turns escaped HTML and markup in values into text", () => {
		const { fields } = clipOf("JSON-LD: entity-escaped");
		expect(fields.title).toBe("Analyst & Reporter");
		expect(fields.company).toBe("Fjord Bank");
		expect(fields.description).toContain("Escaped once.");
		expect(`${fields.title}${fields.company}${fields.description}`).not.toMatch(/[<>]/);
	});
});

describe("clipping a page without JSON-LD", () => {
	it("makes a best guess from Open Graph and the main text", () => {
		const clip = clipOf("no JSON-LD: Open Graph");
		expect(clip.origin).toBe("guess");
		expect(clip.fields).toMatchObject({
			title: "Customer Success Manager",
			company: "Cedar Software",
			location: "",
			salary: "",
			url: "https://jobs.example.test/p/42",
		});
		expect(clip.fields.description).toBe("Something else\nHelp customers succeed.\nOnboarding\nRenewals");
	});

	it("uses the first heading, then the tab title, for the title", () => {
		const heading = clipOf("no JSON-LD: first heading");
		expect(heading.fields).toMatchObject({ title: "Fleet Coordinator", company: "Dune Logistics" });
		expect(clipOf("no JSON-LD: only the tab title").fields.title).toBe("Office Manager - Elm Co");
	});

	it("says there is nothing to find on a page that is not a job", () => {
		const clip = clipOf("a page that is not a job");
		expect(clip.origin).toBe("none");
		expect(clip.fields.title).toBe("");
		expect(clip.fields.description).toBe("");
	});
});

describe("the posting address", () => {
	const raw = (url: string): RawPage => ({
		url,
		title: "x",
		ogTitle: "",
		ogSiteName: "",
		metaCompany: [],
		h1: "",
		mainText: "",
		jsonLd: [],
	});

	it("is the tab address without fragment or tracking parameters", () => {
		expect(parsePosting(raw("https://jobs.example.test/r/1?utm_source=a&utm_term=b&ref_src=c#top")).fields.url).toBe(
			"https://jobs.example.test/r/1",
		);
	});

	it("is empty for an address that is not https, unless the host is allowed (a development build)", () => {
		expect(parsePosting(raw("http://jobs.example.test/r/1")).fields.url).toBe("");
		expect(parsePosting(raw("chrome://extensions")).fields.url).toBe("");
		expect(
			parsePosting(raw("http://localhost:8080/r/1"), { allowHttp: (host) => host === "localhost" }).fields.url,
		).toBe("http://localhost:8080/r/1");
	});

	it("falls back to the posting's own address when the tab address is unusable", () => {
		const page = {
			...raw("http://jobs.example.test/r/1"),
			jsonLd: [JSON.stringify({ "@type": "JobPosting", title: "T", url: "https://careers.example.test/j/9?utm_x=1" })],
		};
		expect(parsePosting(page).fields.url).toBe("https://careers.example.test/j/9");
	});
});

describe("a hostile page", () => {
	it("is read as text only: no script runs, and no tag survives into any field", () => {
		const clip = parsePosting(read(hostile));
		expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
		const everything = Object.values(clip.fields).join("\n");
		expect(everything).not.toMatch(/<\/?(script|iframe|style|img|a)\b/i);
		expect(everything).not.toContain("alert(");
		expect(everything).not.toContain("javascript:");
		expect(clip.fields.title).toBe("Engineer");
		// The injection text is kept, as text: it is the member's to read, and the server treats it as data.
		expect(clip.fields.description).toContain(HOSTILE_INJECTION);
	});

	it("is read within the caps even with a 5 MB body", () => {
		const filler = `<p>${"lorem ipsum dolor sit amet ".repeat(40)}</p>`;
		const body = `<main>${filler.repeat(Math.ceil((5 * 1024 * 1024) / filler.length))}</main>`;
		const started = Date.now();
		const raw = read({
			url: "https://careers.example.test/huge",
			html: `<html><head><title>Huge</title></head><body>${body}</body></html>`,
		});
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(raw.mainText.length).toBeLessThanOrEqual(60_000);
		const clip = parsePosting(raw);
		expect(clip.fields.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
		expect(clip.fields.description.length).toBeGreaterThan(1000);
	});

	it("is read without overflowing the stack when the tree is deeply nested", () => {
		open({
			url: "https://careers.example.test/deep",
			html: "<html><head><title>Deep</title></head><body><main></main></body></html>",
		});
		const main = document.querySelector("main");
		if (!main) throw new Error("no main");
		let node: Element = main;
		for (let depth = 0; depth < 1500; depth += 1) {
			const child = document.createElement("div");
			node.append(child);
			node = child;
		}
		node.append("Deep text at the bottom.");
		const raw = readPageInTab();
		expect(raw.mainText).toContain("Deep text at the bottom.");
		expect(parsePosting(raw).fields.description).toContain("Deep text at the bottom.");
	});

	it("caps every field, whatever the page holds", () => {
		const long = "x".repeat(50_000);
		const clip = parsePosting({
			url: "https://careers.example.test/long",
			title: long,
			ogTitle: long,
			ogSiteName: long,
			metaCompany: [long],
			h1: long,
			mainText: long.repeat(3),
			jsonLd: [
				JSON.stringify({
					"@type": "JobPosting",
					title: long,
					description: long.repeat(10),
					hiringOrganization: { name: long },
				}),
			],
		});
		expect(clip.fields.title).toHaveLength(MAX_FIELD_CHARS);
		expect(clip.fields.company).toHaveLength(MAX_FIELD_CHARS);
		expect(clip.fields.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
	});

	it("does not follow deeply nested JSON-LD arrays", () => {
		const nested = `${"[".repeat(5000)}${"]".repeat(5000)}`;
		expect(findJobPosting([nested])).toBeNull();
		expect(findJobPosting([`{"@graph": ${nested}}`])).toBeNull();
	});
});

describe("helpers", () => {
	it("reads salary in the shapes sites use", () => {
		expect(salaryOf({ currency: "EUR", value: 52000 })).toBe("EUR 52,000");
		expect(salaryOf({ currency: "EUR", value: { value: 30, unitText: "hour" } })).toBe("EUR 30 per hour");
		expect(salaryOf({ currency: "USD", value: { minValue: 90000, unitText: "YEAR" } })).toBe(
			"USD from 90,000 per year",
		);
		expect(salaryOf({ currency: "USD", value: { maxValue: 120000 } })).toBe("USD up to 120,000");
		expect(salaryOf("Competitive")).toBe("Competitive");
		expect(salaryOf({ currency: "USD" })).toBe("");
		expect(salaryOf(undefined)).toBe("");
	});

	it("turns HTML into text without running or loading anything", () => {
		expect(htmlToText("plain text")).toBe("plain text");
		expect(htmlToText("<p>a</p><p>b<br>c</p><script>x()</script>")).toBe("a\nb\nc\n");
	});

	it("reads the reader's answer as untrusted", () => {
		expect(readRawPage(null)).toBeNull();
		expect(readRawPage({ title: "no url" })).toBeNull();
		expect(readRawPage({ url: "https://x.test", jsonLd: [1, "ok"], metaCompany: "no" })).toMatchObject({
			jsonLd: ["ok"],
			metaCompany: [],
		});
	});
});
