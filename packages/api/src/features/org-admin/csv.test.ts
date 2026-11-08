import { describe, expect, it } from "vite-plus/test";
import { CSV_MAX_BYTES, csvCell, csvRow, CsvError, parseInviteCsv } from "./csv";

const bytes = (text: string) => new TextEncoder().encode(text);
const codeOf = (action: () => unknown) => {
	try {
		action();
	} catch (error) {
		return error instanceof CsvError ? error.code : "other";
	}
	return "none";
};

describe("parseInviteCsv", () => {
	it("reads the three columns, trims values and counts lines from the header", () => {
		const rows = parseInviteCsv(
			bytes("Email, Role ,cohort\r\n  a@example.test , admin , Spring 26 \nb@example.test,,\n"),
		);
		expect(rows).toEqual([
			{ line: 2, email: "a@example.test", role: "admin", cohort: "Spring 26" },
			{ line: 3, email: "b@example.test", role: "", cohort: "" },
		]);
	});

	it("accepts a byte order mark, blank lines and a file without a final newline", () => {
		const rows = parseInviteCsv(bytes("﻿email\n\nx@example.test\n\n\ny@example.test"));
		expect(rows.map((row) => row.email)).toEqual(["x@example.test", "y@example.test"]);
	});

	it("ignores columns it does not know and allows them in any order", () => {
		const rows = parseInviteCsv(bytes("name,cohort,email\nAda,Spring,ada@example.test"));
		expect(rows).toEqual([{ line: 2, email: "ada@example.test", role: "", cohort: "Spring" }]);
	});

	it("reads quoted commas, doubled quotes and line breaks inside quotes", () => {
		const rows = parseInviteCsv(bytes('email,cohort\n"a@example.test","Class, ""A""\nnight"\nb@example.test,'));
		expect(rows[0]).toMatchObject({ email: "a@example.test", cohort: 'Class, "A"\nnight' });
		expect(rows[1]).toMatchObject({ line: 4, email: "b@example.test", cohort: "" });
	});

	it("does not evaluate formulas: a cell stays the text it is", () => {
		const rows = parseInviteCsv(bytes('email,cohort\n"=HYPERLINK(""x"")",+1+1\n'));
		expect(rows[0]).toMatchObject({ email: '=HYPERLINK("x")', cohort: "+1+1" });
	});

	it("refuses bytes that are not UTF-8", () => {
		expect(codeOf(() => parseInviteCsv(new Uint8Array([0x65, 0x6d, 0x61, 0x69, 0x6c, 0x0a, 0xff, 0xfe])))).toBe(
			"bad_encoding",
		);
		// UTF-16 with a byte order mark is not UTF-8 either.
		expect(codeOf(() => parseInviteCsv(new Uint8Array([0xff, 0xfe, 0x65, 0x00])))).toBe("bad_encoding");
	});

	it("refuses a file with a NUL byte", () => {
		expect(codeOf(() => parseInviteCsv(bytes("email\na@example.test\u0000")))).toBe("binary");
	});

	it("refuses an empty file and a file without an email column", () => {
		expect(codeOf(() => parseInviteCsv(bytes("")))).toBe("empty");
		expect(codeOf(() => parseInviteCsv(bytes("\n\n  \n")))).toBe("empty");
		expect(codeOf(() => parseInviteCsv(bytes("name,role\nAda,member")))).toBe("no_email_column");
	});

	it("refuses a repeated column", () => {
		expect(codeOf(() => parseInviteCsv(bytes("email,role,EMAIL\na@example.test,member,b@example.test")))).toBe(
			"duplicate_column",
		);
	});

	it("refuses a row with more values than the header has columns", () => {
		expect(codeOf(() => parseInviteCsv(bytes("email\na@example.test,member")))).toBe("too_many_fields");
	});

	it("refuses broken quoting", () => {
		expect(codeOf(() => parseInviteCsv(bytes('email\n"a@example.test')))).toBe("bad_quote");
		expect(codeOf(() => parseInviteCsv(bytes('email\na"b@example.test')))).toBe("bad_quote");
		expect(codeOf(() => parseInviteCsv(bytes('email\n"a"b@example.test')))).toBe("bad_quote");
	});

	it("allows 500 rows and refuses 501", () => {
		const make = (count: number) =>
			`email\n${Array.from({ length: count }, (_, i) => `u${i}@example.test`).join("\n")}`;
		expect(parseInviteCsv(bytes(make(500)))).toHaveLength(500);
		expect(codeOf(() => parseInviteCsv(bytes(make(501))))).toBe("too_many_rows");
	});

	it("refuses more than 256 KB", () => {
		expect(codeOf(() => parseInviteCsv(new Uint8Array(CSV_MAX_BYTES + 1)))).toBe("too_large");
	});
});

describe("csvCell", () => {
	it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd"])("writes %j as text", (value) => {
		const cell = csvCell(value);
		expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
	});

	it("leaves numbers, dates and ordinary text alone", () => {
		expect(csvCell(-3)).toBe("-3");
		expect(csvCell(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
		expect(csvCell("Ada Lovelace")).toBe("Ada Lovelace");
		expect(csvCell(null)).toBe("");
	});

	it("quotes commas, quotes and line breaks", () => {
		expect(csvCell('a,"b"')).toBe('"a,""b"""');
		expect(csvCell("a\nb")).toBe('"a\nb"');
		// A formula that also needs quoting keeps the apostrophe inside the quotes.
		expect(csvCell('=A1,"x"')).toBe(`"'=A1,""x"""`);
	});

	it("ends a row with a CRLF", () => {
		expect(csvRow(["a", 1, null])).toBe("a,1,\r\n");
	});
});
