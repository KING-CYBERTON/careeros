// CAREEROS (P5-T04): the template renderer. Plain text in, plain text out. A template names a value with
// `{{firstName}}`; the renderer swaps it for the value, or for a visible `[firstName]` placeholder when the value is
// missing, and leaves anything it does not know exactly as typed. It does no HTML, no escaping rules, no expressions
// and no lookups beyond this fixed list, so a template can never run code or pull in data it was not given.

export const VARIABLE_NAMES = [
	"firstName",
	"fullName",
	"company",
	"role",
	"contactName",
	"interviewDate",
	"myEmail",
] as const;
export type VariableName = (typeof VARIABLE_NAMES)[number];

export type TemplateValues = Partial<Record<VariableName, string | null | undefined>>;

const KNOWN = new Set<string>(VARIABLE_NAMES);

// Two braces, a name, two braces; spaces inside the braces are allowed. One pass over the text: a value that itself
// contains `{{company}}` is inserted as text and is never expanded again.
const VARIABLE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

// Control characters other than a tab and a line break (a value from a pasted posting can carry them).
// oxlint-disable-next-line no-control-regex -- control characters are exactly what is removed here.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const clean = (value: string | null | undefined): string => (value ?? "").replace(CONTROL, "").replace(/\r\n?/g, "\n");

/** The placeholder a missing value becomes, so it is seen and filled in before the email is sent. */
export const placeholderFor = (name: VariableName): string => `[${name}]`;

/** Fills the variables of `text`. Unknown variables stay as typed; a missing or blank value becomes `[name]`. */
export function renderTemplate(text: string, values: TemplateValues): string {
	return text.replace(VARIABLE, (whole, name: string) => {
		if (!KNOWN.has(name)) return whole;
		const value = clean(values[name as VariableName]).trim();
		return value === "" ? placeholderFor(name as VariableName) : value;
	});
}

/** A subject is one line: line breaks and runs of spaces inside it (from a value) become a single space. */
export function renderSubject(text: string, values: TemplateValues): string {
	return renderTemplate(text, values).replace(/\s+/g, " ").trim();
}

/** The variable names a text uses, known ones only, in order of first use. */
export function variablesIn(text: string): VariableName[] {
	const found: VariableName[] = [];
	for (const match of text.matchAll(VARIABLE)) {
		const name = match[1];
		if (name && KNOWN.has(name) && !found.includes(name as VariableName)) found.push(name as VariableName);
	}
	return found;
}

/** The first word of a person's name, for a signature or a greeting. Empty when there is no name. */
export function firstNameOf(fullName: string | null | undefined): string {
	return (fullName ?? "").trim().split(/\s+/)[0] ?? "";
}
