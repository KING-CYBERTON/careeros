import { describe, expect, it } from "vite-plus/test";
import { MAX_TEXT_LENGTH, plainText, safeHttpsUrl, sanitizeDescription } from "./sanitize";

describe("sanitizeDescription", () => {
	it("keeps headings, paragraphs, lists, bold, italic and line breaks", () => {
		const html = "<h1>A</h1><h6>B</h6><p>x<br>y</p><ul><li>1</li></ul><ol><li>2</li></ol><strong>s</strong><em>e</em>";
		expect(sanitizeDescription(html)).toBe(
			"<h1>A</h1><h6>B</h6><p>x<br />y</p><ul><li>1</li></ul><ol><li>2</li></ol><strong>s</strong><em>e</em>",
		);
	});

	it("turns b and i into strong and em", () => {
		expect(sanitizeDescription("<b>x</b><i>y</i>")).toBe("<strong>x</strong><em>y</em>");
	});

	it("keeps only an https link, always with rel noopener nofollow", () => {
		expect(
			sanitizeDescription('<a href="https://example.test/a?b=1" target="_blank" rel="opener" onclick="x()">go</a>'),
		).toBe('<a href="https://example.test/a?b=1" rel="noopener nofollow">go</a>');
	});

	it.each([
		'<a href="http://example.test">x</a>',
		'<a href="javascript:alert(1)">x</a>',
		'<a href="JaVaScRiPt:alert(1)">x</a>',
		'<a href="data:text/html;base64,AAAA">x</a>',
		'<a href="//example.test/x">x</a>',
		'<a href="https://user:pass@example.test/">x</a>',
		'<a href="mailto:a@example.test">x</a>',
	])("drops the address of %s but keeps its text", (html) => {
		const out = sanitizeDescription(html);
		expect(out).toBe("<a>x</a>");
	});

	it.each([
		["<script>alert(1)</script>ok", "ok"],
		["<style>p{color:red}</style>ok", "ok"],
		['<img src="https://example.test/x.png" onerror="x()">ok', "ok"],
		['<iframe src="https://example.test"></iframe>ok', "ok"],
		['<form action="https://example.test"><input name="a"></form>ok', "ok"],
		['<svg onload="x()"><circle/></svg>ok', "ok"],
		['<p style="color:red" class="x" id="y">ok</p>', "<p>ok</p>"],
		["<object data=x></object>ok", "ok"],
	])("removes active content: %s", (html, expected) => {
		expect(sanitizeDescription(html)).toBe(expected);
	});

	it("unescapes Greenhouse's once-escaped HTML before cleaning it", () => {
		expect(sanitizeDescription("&lt;p&gt;Hi &lt;script&gt;x()&lt;/script&gt;&lt;/p&gt;")).toBe("<p>Hi </p>");
	});

	it("leaves plain text with an ampersand alone", () => {
		expect(sanitizeDescription("Tom &amp; Jerry")).toBe("Tom &amp; Jerry");
	});

	it("returns an empty string for non-text input", () => {
		expect(sanitizeDescription(null)).toBe("");
		expect(sanitizeDescription(42)).toBe("");
		expect(sanitizeDescription("   ")).toBe("");
	});

	it("survives a very large hostile input", () => {
		const out = sanitizeDescription("<p>".repeat(500_000));
		expect(typeof out).toBe("string");
	});
});

describe("plainText", () => {
	it("strips tags and decodes the basic entities", () => {
		expect(plainText("<b>Dev</b> &amp; Ops <script>x()</script>")).toBe("Dev & Ops");
	});

	it("collapses whitespace, drops control characters and trims", () => {
		expect(plainText("  Senior\n\t Engineer\u0000\u0007  ")).toBe("Senior Engineer");
	});

	it(`caps the text at ${MAX_TEXT_LENGTH} characters`, () => {
		expect(plainText("x".repeat(1000))).toHaveLength(MAX_TEXT_LENGTH);
	});

	it("returns an empty string for non-text input", () => {
		expect(plainText(undefined)).toBe("");
		expect(plainText({})).toBe("");
	});
});

describe("safeHttpsUrl", () => {
	it("accepts https and drops the fragment", () => {
		expect(safeHttpsUrl(" https://example.test/jobs/1#apply ")).toBe("https://example.test/jobs/1");
	});

	it.each([
		"http://example.test",
		"javascript:alert(1)",
		"data:text/plain,x",
		"ftp://example.test",
		"https://u:p@example.test",
		"not a url",
		"",
		5,
		null,
	])("refuses %j", (value) => {
		expect(safeHttpsUrl(value)).toBeNull();
	});
});
