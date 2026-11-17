// CAREEROS (P3-T08, phase plan D8): the strict CSV reader for bulk invitations and the CSV writer for exports. Pure:
// no database, no HTTP. Nothing here evaluates a cell: a value is a string, trimmed, and nothing else.

export const CSV_MAX_BYTES = 256 * 1024;
export const CSV_MAX_ROWS = 500;

export type CsvErrorCode =
	| "too_large"
	| "bad_encoding"
	| "binary"
	| "empty"
	| "bad_quote"
	| "no_email_column"
	| "duplicate_column"
	| "too_many_rows"
	| "too_many_fields";

/** Raised for a file that cannot be read as the invitation list. The message is safe to show to the admin. */
export class CsvError extends Error {
	readonly code: CsvErrorCode;
	constructor(code: CsvErrorCode, message: string) {
		super(message);
		this.name = "CsvError";
		this.code = code;
	}
}

export type InviteCsvRow = {
	/** The 1-based line of the row in the file, counting the header as line 1. */
	line: number;
	email: string;
	role: string;
	cohort: string;
};

const KNOWN_COLUMNS = ["email", "role", "cohort"] as const;

/** Splits RFC 4180 text into records. Quoted fields may hold commas, quotes ("") and line breaks. */
function splitRecords(text: string): { line: number; fields: string[] }[] {
	const records: { line: number; fields: string[] }[] = [];
	let fields: string[] = [];
	let field = "";
	let quoted = false;
	let fieldStarted = false;
	let afterQuote = false;
	let line = 1;
	let recordLine = 1;
	const endField = () => {
		fields.push(field);
		field = "";
		fieldStarted = false;
		afterQuote = false;
	};
	const endRecord = () => {
		endField();
		records.push({ line: recordLine, fields });
		fields = [];
	};
	for (let index = 0; index < text.length; index++) {
		const char = text[index] as string;
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index++;
				} else {
					quoted = false;
					afterQuote = true;
				}
			} else {
				if (char === "\n") line++;
				field += char;
			}
			continue;
		}
		if (char === '"') {
			if (fieldStarted) throw new CsvError("bad_quote", `Line ${line} has a quote inside an unquoted value.`);
			quoted = true;
			fieldStarted = true;
		} else if (char === ",") {
			endField();
		} else if (char === "\r" || char === "\n") {
			if (char === "\r" && text[index + 1] === "\n") index++;
			endRecord();
			line++;
			recordLine = line;
		} else {
			// A character right after a closing quote ("a"b) is as malformed as a quote inside plain text.
			if (afterQuote) throw new CsvError("bad_quote", `Line ${line} has text after a closing quote.`);
			field += char;
			fieldStarted = true;
		}
	}
	if (quoted) throw new CsvError("bad_quote", `The quote opened on line ${recordLine} is never closed.`);
	if (fieldStarted || field !== "" || fields.length > 0) endRecord();
	return records;
}

/**
 * Reads the invitation list: UTF-8 only, a header row naming `email` (required), and optionally `role` and `cohort`;
 * other columns are ignored. Values are trimmed, blank lines are skipped, and at most 500 data rows are allowed.
 * Throws `CsvError`. Emails and roles are validated later, row by row, so one bad row never hides the others.
 */
export function parseInviteCsv(bytes: Uint8Array): InviteCsvRow[] {
	if (bytes.byteLength > CSV_MAX_BYTES) throw new CsvError("too_large", "The file is larger than 256 KB.");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new CsvError("bad_encoding", "The file is not UTF-8 text. Save it as CSV (UTF-8) and try again.");
	}
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	if (text.includes("\u0000")) throw new CsvError("binary", "The file is not a text CSV.");

	const records = splitRecords(text).filter((record) => record.fields.some((value) => value.trim() !== ""));
	const header = records.shift();
	if (!header) throw new CsvError("empty", "The file is empty. Add a header row with an email column.");

	const columns = new Map<string, number>();
	for (const [index, raw] of header.fields.entries()) {
		const name = raw.trim().toLowerCase();
		if (!(KNOWN_COLUMNS as readonly string[]).includes(name)) continue;
		if (columns.has(name)) throw new CsvError("duplicate_column", `The column "${name}" appears twice.`);
		columns.set(name, index);
	}
	if (!columns.has("email")) throw new CsvError("no_email_column", 'The first row must name an "email" column.');
	if (records.length > CSV_MAX_ROWS)
		throw new CsvError(
			"too_many_rows",
			`The file has ${records.length} rows. The limit is ${CSV_MAX_ROWS} per upload.`,
		);

	return records.map((record) => {
		if (record.fields.length > header.fields.length)
			throw new CsvError("too_many_fields", `Line ${record.line} has more values than the header has columns.`);
		const read = (name: (typeof KNOWN_COLUMNS)[number]) => {
			const index = columns.get(name);
			return index === undefined ? "" : (record.fields[index] ?? "").trim();
		};
		return { line: record.line, email: read("email"), role: read("role"), cohort: read("cohort") };
	});
}

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell. A string that a spreadsheet would read as a formula (it begins with `=`, `+`, `-`, `@`, a tab or a
 * carriage return) gets a leading apostrophe, so it opens as text. Numbers, booleans and dates are written as they
 * are; `null` is an empty cell.
 */
export function csvCell(value: string | number | boolean | Date | null | undefined): string {
	if (value === null || value === undefined) return "";
	let text = value instanceof Date ? value.toISOString() : String(value);
	if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(values: (string | number | boolean | Date | null | undefined)[]): string {
	return `${values.map(csvCell).join(",")}\r\n`;
}
