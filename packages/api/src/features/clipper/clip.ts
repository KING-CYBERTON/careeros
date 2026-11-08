import type { applicationDto } from "../../dto/application";
import type z from "zod";
import {
	APPLICATION_SOURCES,
	cleanBlock,
	cleanLine,
	cleanPostingUrl,
	isClipperSource,
	MAX_DESCRIPTION_CHARS,
	MAX_FIELD_CHARS,
} from "@careeros/job-posting";
import { ORPCError } from "@orpc/server";
import sanitizeHtml from "sanitize-html";

// CAREEROS (P5-T03): what the API does to a clipped job, whatever the client sent. The job text comes from a web page
// the member does not control: it is turned into plain text here (no tag survives), capped to the same numbers the
// extension uses, and stored as text. Every place that shows it renders text, never HTML.

type CreateApplicationInput = z.infer<typeof applicationDto.create.input>;

/** Longer values are cut before cleaning, so a hostile 5 MB description costs little. */
const MAX_MARKUP_INPUT = 200_000;

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

/** A tag that ends a line of text: its end (or a line break) becomes a line feed so paragraphs and list items survive. */
const LINE_BREAKS = /<br\s*\/?>|<\/(?:p|div|li|ul|ol|tr|section|article|h[1-6])\s*>/gi;

/**
 * Plain text from text that may hold markup: every tag is dropped (and the contents of script, style and similar), the
 * basic entities are decoded, whitespace is collapsed to the extension's rules. A posting whose HTML was escaped once
 * (`&lt;p&gt;`, as some job boards send it) is unescaped a single time first, so no tag text is left behind.
 */
export function plainFromMarkup(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") return "";
	let text = value.slice(0, MAX_MARKUP_INPUT);
	if (!text.includes("<") && /&lt;[a-z/]/i.test(text)) text = decodeBasicEntities(text);
	const stripped = sanitizeHtml(text.replace(LINE_BREAKS, "\n"), { allowedTags: [], allowedAttributes: {} });
	return decodeBasicEntities(stripped);
}

/** A title, company, location or salary: one line of plain text, at most 300 characters. */
export function clipLine(value: unknown): string {
	return cleanLine(plainFromMarkup(value), MAX_FIELD_CHARS);
}

/** A description: plain text with paragraph breaks, at most 20,000 characters. */
export function clipDescription(value: unknown): string {
	return cleanBlock(plainFromMarkup(value), MAX_DESCRIPTION_CHARS);
}

/** The address to keep: no fragment and no tracking parameters; `undefined` when there is none or it is unusable. */
export function clipUrl(value: unknown): string | undefined {
	return cleanPostingUrl(value, { allowHttp: true }) ?? undefined;
}

const nullable = <T>(value: T | null | undefined, clean: (input: T) => string): string | null | undefined =>
	value === undefined ? undefined : value === null ? null : clean(value) || null;

/**
 * The input `applications.create` stores. A request that carries a clipper token gets only the fields a clip has, in the
 * first stage, with the clipper marker; anything else it sent (files, links to documents, a stage) is dropped. Any other
 * caller that uses the clipper marker has its job text cleaned the same way and keeps its other fields.
 */
export function prepareClippedCreate(
	input: CreateApplicationInput,
	method: string | undefined,
): CreateApplicationInput {
	const byToken = method === "clipper";
	if (!byToken && !isClipperSource(input.source)) return input;

	const company = clipLine(input.company);
	const role = clipLine(input.role);
	if (!company || !role)
		throw new ORPCError("BAD_REQUEST", { message: "A clipped job needs a title and a company in plain text." });

	const sourceUrl =
		input.sourceUrl === undefined || input.sourceUrl === null ? input.sourceUrl : (clipUrl(input.sourceUrl) ?? null);
	const text = {
		company,
		role,
		location: nullable(input.location, clipLine),
		salary: nullable(input.salary, clipLine),
		jobDescription: nullable(input.jobDescription, clipDescription),
		sourceUrl,
		source: APPLICATION_SOURCES.clipper,
	};

	if (!byToken) return { ...input, ...text };
	// The token's request is rebuilt from the clip's own fields: no document links, no files, no other stage.
	return {
		company: text.company,
		role: text.role,
		status: "saved",
		source: text.source,
		...(text.location === undefined ? {} : { location: text.location }),
		...(text.salary === undefined ? {} : { salary: text.salary }),
		...(text.jobDescription === undefined ? {} : { jobDescription: text.jobDescription }),
		...(text.sourceUrl === undefined ? {} : { sourceUrl: text.sourceUrl }),
	};
}
