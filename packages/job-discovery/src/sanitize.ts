import sanitizeHtml from "sanitize-html";

/** Titles, company names and locations: plain text, trimmed and capped (G4). */
export const MAX_TEXT_LENGTH = 300;
/** Longer descriptions are cut before sanitizing, so a hostile 5 MB posting costs little to clean. */
export const MAX_DESCRIPTION_INPUT = 200_000;

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&#x27;": "'",
	"&nbsp;": " ",
};

function decodeBasicEntities(value: string): string {
	return value.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** Drops control characters other than tab and line feed (whitespace is collapsed afterwards). */
function dropControlCharacters(value: string): string {
	let out = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) continue;
		out += character;
	}
	return out;
}

/** Strips every tag (and the contents of script and style), decodes the basic entities, collapses whitespace. */
export function plainText(value: unknown, max = MAX_TEXT_LENGTH): string {
	if (typeof value !== "string") return "";
	const stripped = sanitizeHtml(value.slice(0, MAX_DESCRIPTION_INPUT), { allowedTags: [], allowedAttributes: {} });
	return dropControlCharacters(decodeBasicEntities(stripped)).replace(/\s+/g, " ").trim().slice(0, max);
}

/** The https URL, normalized, or `null`. Credentials, other schemes and unparsable values are refused. */
export function safeHttpsUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" || url.username || url.password) return null;
		url.hash = "";
		return url.toString();
	} catch {
		return null;
	}
}

const ALLOWED_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "strong", "em", "a", "br"];

/**
 * Greenhouse sends `content` as HTML that was entity-escaped once (`&lt;p&gt;`). When the text holds escaped tags and
 * no real ones, it is unescaped a single time before sanitizing.
 */
export function unescapeOnce(value: string): string {
	if (value.includes("<") || !/&lt;[a-z/]/i.test(value)) return value;
	return decodeBasicEntities(value);
}

/**
 * The strict allow-list (G4): headings, paragraphs, lists, bold, italic, line breaks and links. A link keeps only an
 * https `href` and always gets `rel="noopener nofollow"`; everything else (attributes, styles, scripts, forms, images,
 * iframes) is dropped. `b` and `i` become `strong` and `em`.
 */
export function sanitizeDescription(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "";
	return sanitizeHtml(unescapeOnce(value.slice(0, MAX_DESCRIPTION_INPUT)), {
		allowedTags: ALLOWED_TAGS,
		allowedAttributes: { a: ["href", "rel"] },
		allowedSchemes: ["https"],
		allowedSchemesAppliedToAttributes: ["href"],
		allowProtocolRelative: false,
		disallowedTagsMode: "discard",
		transformTags: {
			b: "strong",
			i: "em",
			a: (tagName, attribs) => {
				const href = safeHttpsUrl(attribs.href);
				return { tagName, attribs: href ? { href, rel: "noopener nofollow" } : {} };
			},
		},
	}).trim();
}
