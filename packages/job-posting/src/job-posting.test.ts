import { describe, expect, it } from "vite-plus/test";
import {
	APPLICATION_SOURCES,
	capText,
	cleanBlock,
	cleanLine,
	cleanPostingUrl,
	isClipperSource,
	MAX_DESCRIPTION_CHARS,
	MAX_FIELD_CHARS,
	normalizePostingUrl,
	postingHost,
} from "./index";

describe("cleanPostingUrl", () => {
	it("keeps an https address and drops the fragment and tracking parameters", () => {
		expect(
			cleanPostingUrl(
				"https://jobs.example.test/roles/42?gh_jid=42&utm_source=news&utm_medium=x&fbclid=abc&ref_src=tw#apply",
			),
		).toBe("https://jobs.example.test/roles/42?gh_jid=42");
	});

	it("removes the whole query when only tracking was in it", () => {
		expect(cleanPostingUrl("https://jobs.example.test/r/1?utm_campaign=a&gclid=b")).toBe(
			"https://jobs.example.test/r/1",
		);
	});

	it("matches tracking names whatever their case", () => {
		expect(cleanPostingUrl("https://jobs.example.test/r?UTM_Source=a&GCLID=b&id=7")).toBe(
			"https://jobs.example.test/r?id=7",
		);
	});

	it("refuses other schemes, credentials, garbage and over-long addresses", () => {
		for (const value of [
			"javascript:alert(1)",
			"data:text/html,<b>x</b>",
			"file:///etc/passwd",
			"ftp://example.test/x",
			"https://user:pw@example.test/x",
			"not a url",
			"",
			"   ",
			42,
			null,
			undefined,
			`https://example.test/${"a".repeat(3000)}`,
		])
			expect(cleanPostingUrl(value), String(value).slice(0, 40)).toBeNull();
	});

	it("refuses http unless it is allowed, and then only for the allowed hosts", () => {
		expect(cleanPostingUrl("http://jobs.example.test/x")).toBeNull();
		expect(cleanPostingUrl("http://jobs.example.test/x", { allowHttp: true })).toBe("http://jobs.example.test/x");
		const localhostOnly = { allowHttp: (host: string) => host === "localhost" };
		expect(cleanPostingUrl("http://localhost:8080/job#x", localhostOnly)).toBe("http://localhost:8080/job");
		expect(cleanPostingUrl("http://jobs.example.test/x", localhostOnly)).toBeNull();
	});
});

describe("normalizePostingUrl", () => {
	it("makes the same posting reached by different links one address", () => {
		const forms = [
			"https://www.Jobs.Example.test/roles/42/?utm_source=a#top",
			"http://jobs.example.test/roles/42",
			"https://jobs.example.test/roles/42//?fbclid=z",
		];
		const normalized = forms.map(normalizePostingUrl);
		expect(new Set(normalized).size).toBe(1);
		expect(normalized[0]).toBe("jobs.example.test/roles/42");
	});

	it("keeps what identifies the posting: path, port and the other parameters in a fixed order", () => {
		expect(normalizePostingUrl("https://jobs.example.test/r?b=2&a=1")).toBe("jobs.example.test/r?a=1&b=2");
		expect(normalizePostingUrl("https://jobs.example.test/r?a=1&b=2")).toBe("jobs.example.test/r?a=1&b=2");
		expect(normalizePostingUrl("https://jobs.example.test:8443/r")).toBe("jobs.example.test:8443/r");
		expect(normalizePostingUrl("https://jobs.example.test/r/1")).not.toBe(
			normalizePostingUrl("https://jobs.example.test/r/2"),
		);
		expect(normalizePostingUrl("https://jobs.example.test/")).toBe("jobs.example.test/");
	});

	it("is null for anything that is not an http(s) address", () => {
		expect(normalizePostingUrl("mailto:a@example.test")).toBeNull();
		expect(normalizePostingUrl(undefined)).toBeNull();
	});

	it("names the host for narrowing a search", () => {
		expect(postingHost("https://www.jobs.example.test:8443/r?x=1")).toBe("jobs.example.test:8443");
		expect(postingHost("nope")).toBeNull();
	});
});

describe("text helpers", () => {
	it("collapses whitespace, drops control characters and caps a line", () => {
		expect(cleanLine("  Senior \n\t Engineer\u0000   (Remote) ")).toBe("Senior Engineer (Remote)");
		expect(cleanLine("x".repeat(5000))).toHaveLength(MAX_FIELD_CHARS);
		expect(cleanLine(12)).toBe("");
		expect(cleanLine("abc", 2)).toBe("ab");
	});

	it("never cuts a surrogate pair in half", () => {
		const text = `${"a".repeat(299)}😀😀`;
		const cut = capText(text, MAX_FIELD_CHARS);
		expect(cut).toBe("a".repeat(299));
		expect(capText("ab😀", 3)).toBe("ab");
	});

	it("keeps paragraph breaks in a block and collapses the rest", () => {
		const block = cleanBlock("  Line one  \r\n\r\n\r\n\r\nLine\t two   \nLine\u0007 three\n\n");
		expect(block).toBe("Line one\n\nLine two\nLine three");
		expect(cleanBlock("y".repeat(50_000))).toHaveLength(MAX_DESCRIPTION_CHARS);
		expect(cleanBlock(null)).toBe("");
	});
});

describe("source marker", () => {
	it("names the two features that create applications", () => {
		expect(APPLICATION_SOURCES).toEqual({ clipper: "clipper", discovery: "discovery" });
	});

	it("recognizes the clipper marker whatever its case or spacing, and nothing else", () => {
		expect(isClipperSource("clipper")).toBe(true);
		expect(isClipperSource(" Clipper ")).toBe(true);
		expect(isClipperSource("discovery")).toBe(false);
		expect(isClipperSource("LinkedIn")).toBe(false);
		expect(isClipperSource(null)).toBe(false);
	});
});
