// CAREEROS (P5-T03): plain-text helpers shared by the extension and the API. Everything here returns text, never markup:
// a clipped job is untrusted, and nothing in it may reach a page as HTML.
import { MAX_DESCRIPTION_CHARS, MAX_FIELD_CHARS } from "./limits";

/** Cuts a string to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function capText(value: string, max: number): string {
	if (value.length <= max) return value;
	const cut = value.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Control characters other than tab and line feed (carriage return is turned into a line feed first). */
function dropControlCharacters(value: string): string {
	let out = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if ((code < 32 && code !== 9 && code !== 10) || code === 127 || (code >= 0x80 && code <= 0x9f)) continue;
		out += character;
	}
	return out;
}

/** One line of text: control characters dropped, every run of whitespace one space, trimmed, capped. */
export function cleanLine(value: unknown, max = MAX_FIELD_CHARS): string {
	if (typeof value !== "string") return "";
	// A hostile 5 MB value costs little: only what can survive the cap is looked at.
	const head = value.length > max * 8 ? value.slice(0, max * 8) : value;
	return capText(dropControlCharacters(head).replace(/\s+/g, " ").trim(), max);
}

/**
 * A description: control characters dropped, spaces and tabs collapsed, lines trimmed, no more than one blank line in a
 * row, trimmed, capped. Paragraph breaks survive so the tracker shows the posting as it reads.
 */
export function cleanBlock(value: unknown, max = MAX_DESCRIPTION_CHARS): string {
	if (typeof value !== "string") return "";
	const head = value.length > max * 4 ? value.slice(0, max * 4) : value;
	const text = dropControlCharacters(head.replace(/\r\n?/g, "\n"))
		.replace(/[^\S\n]+/g, " ")
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return capText(text, max);
}
