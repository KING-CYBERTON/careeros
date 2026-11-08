import type { RawPage } from "./reader";
// CAREEROS (P5-T03): from what the reader found to the fields of a clip. `JobPosting` JSON-LD first (a single object, an
// array, `@graph`, `@type` as a string or an array); otherwise the page's own title and text as a best guess. Everything
// the page says is text: values go through an inert HTML parser that only yields `textContent` (no script runs, nothing
// loads), are cut to the caps, and are shown by React as text. Malformed JSON-LD is skipped, never an error.
import {
	cleanBlock,
	cleanLine,
	cleanPostingUrl,
	MAX_DESCRIPTION_CHARS,
	MAX_FIELD_CHARS,
	type CleanUrlOptions,
} from "@careeros/job-posting";

/** Where the form's values came from: JSON-LD ("page"), the page's own title and text ("guess"), or nothing ("none"). */
export type ClipOrigin = "page" | "guess" | "none";

export type ClipFields = {
	title: string;
	company: string;
	location: string;
	salary: string;
	url: string;
	description: string;
};

export type Clip = { origin: ClipOrigin; fields: ClipFields };

export const EMPTY_FIELDS: ClipFields = { title: "", company: "", location: "", salary: "", url: "", description: "" };

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const asText = (value: unknown): string =>
	typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const asList = (value: unknown): unknown[] =>
	Array.isArray(value) ? value.slice(0, 20) : value === undefined ? [] : [value];

/** HTML (or plain text) as text. The parsed document is inert: no script runs and no resource loads. */
export function htmlToText(html: string): string {
	const head = html.slice(0, 200_000);
	if (!head.includes("<") && !head.includes("&")) return head;
	const doc = new DOMParser().parseFromString(head, "text/html");
	for (const element of Array.from(doc.querySelectorAll("script, style, template, noscript, iframe, object, embed")))
		element.remove();
	for (const element of Array.from(doc.querySelectorAll("br"))) element.replaceWith("\n");
	for (const element of Array.from(
		doc.querySelectorAll("p, div, li, ul, ol, tr, section, article, h1, h2, h3, h4, h5, h6"),
	))
		element.append("\n");
	return doc.body.textContent ?? "";
}

/** Descriptions are often escaped twice ("&amp;lt;p&amp;gt;"): when markup is still left after one pass, read it once more. */
const MARKUP = /<\/?[a-z][^>]*>/i;
export function descriptionText(html: string): string {
	const once = htmlToText(html);
	return MARKUP.test(once) ? htmlToText(once) : once;
}

const line = (value: unknown): string => cleanLine(htmlToText(asText(value)), MAX_FIELD_CHARS);

const JOB_POSTING = /(?:^|[/#:])jobposting$/i;

function isJobPosting(node: Record_): boolean {
	return asList(node["@type"]).some((type) => typeof type === "string" && JOB_POSTING.test(type.trim()));
}

/** The first `JobPosting` in any block: a single object, an array of objects, or `@graph`. Bounded, never recursive. */
export function findJobPosting(blocks: readonly string[]): Record_ | null {
	for (const text of blocks) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			continue;
		}
		const queue: unknown[] = [parsed];
		for (let seen = 0; queue.length > 0 && seen < 2000; seen += 1) {
			const node = queue.shift();
			if (Array.isArray(node)) {
				queue.push(...node.slice(0, 500));
				continue;
			}
			if (!isRecord(node)) continue;
			if (isJobPosting(node)) return node;
			const graph = node["@graph"];
			if (Array.isArray(graph)) queue.push(...graph.slice(0, 500));
		}
	}
	return null;
}

function nameOf(value: unknown): string {
	const node = asList(value)[0];
	if (typeof node === "string") return line(node);
	return isRecord(node) ? line(node.name ?? node.legalName) : "";
}

function addressText(address: unknown): string {
	if (typeof address === "string") return line(address);
	if (!isRecord(address)) return "";
	const country = isRecord(address.addressCountry) ? address.addressCountry.name : address.addressCountry;
	return [address.addressLocality, address.addressRegion, country].map(line).filter(Boolean).join(", ");
}

function locationOf(posting: Record_): string {
	const places = asList(posting.jobLocation)
		.slice(0, 5)
		.map((place) => (isRecord(place) ? addressText(place.address) || line(place.name) : addressText(place)))
		.filter(Boolean);
	const place = [...new Set(places)].join("; ");
	const remote = asList(posting.jobLocationType).some((type) => asText(type).toUpperCase() === "TELECOMMUTE");
	if (remote) return place ? `Remote (${place})` : "Remote";
	return place;
}

const asNumber = (value: unknown): number | undefined => {
	const number =
		typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number : undefined;
};
const amount = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

function unitOf(unit: string): string {
	if (/hour/i.test(unit)) return "per hour";
	if (/day/i.test(unit)) return "per day";
	if (/week/i.test(unit)) return "per week";
	if (/month/i.test(unit)) return "per month";
	if (/year|annual/i.test(unit)) return "per year";
	return "";
}

/** `baseSalary` as text: "USD 90,000 - 120,000 per year". Only what the posting states; nothing is worked out. */
export function salaryOf(baseSalary: unknown): string {
	const node = asList(baseSalary)[0];
	if (typeof node === "string" || typeof node === "number") return line(node);
	if (!isRecord(node)) return "";
	const currency = line(node.currency);
	const quantity = isRecord(node.value) ? node.value : undefined;
	const min = asNumber(quantity?.minValue);
	const max = asNumber(quantity?.maxValue);
	const single = asNumber(quantity ? quantity.value : node.value);
	const unit = unitOf(asText(quantity?.unitText));
	let figure = "";
	if (min !== undefined && max !== undefined) figure = min === max ? amount(min) : `${amount(min)} - ${amount(max)}`;
	else if (min !== undefined) figure = single === undefined ? `from ${amount(min)}` : amount(single);
	else if (max !== undefined) figure = `up to ${amount(max)}`;
	else if (single !== undefined) figure = amount(single);
	return figure ? [currency, figure, unit].filter(Boolean).join(" ") : "";
}

const humanize = (value: string) => {
	const words = value.replace(/[_-]+/g, " ").trim().toLowerCase();
	return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "";
};
const day = (value: unknown): string => {
	const text = asText(value).trim();
	return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : line(text);
};

/** One line of what the posting says about the role besides its text: type, date posted, closing date. */
function detailsOf(posting: Record_): string {
	const types = asList(posting.employmentType)
		.map((type) => humanize(line(type)))
		.filter(Boolean);
	const posted = day(posting.datePosted);
	const until = day(posting.validThrough);
	return [types.join(", "), posted && `Posted ${posted}`, until && `Apply by ${until}`].filter(Boolean).join(" · ");
}

export type ParseOptions = CleanUrlOptions;

/**
 * The clip for a page. `JobPosting` JSON-LD fills what it has ("page"); a page without it gets its Open Graph title (or
 * first heading, or tab title), its site name and its main text ("guess"); a page with neither gets empty fields ("none").
 */
export function parsePosting(raw: RawPage, options: ParseOptions = {}): Clip {
	const posting = findJobPosting(raw.jsonLd);

	const guessedTitle = line(raw.ogTitle) || line(raw.h1) || line(raw.title);
	const guessedCompany =
		line(raw.ogSiteName) || raw.metaCompany.map((value) => line(value.replace(/^@/, ""))).find(Boolean) || "";
	const mainText = cleanBlock(htmlToText(raw.mainText), MAX_DESCRIPTION_CHARS);

	let url = cleanPostingUrl(raw.url, options);
	if (!url && posting) {
		try {
			url = cleanPostingUrl(new URL(asText(posting.url), raw.url).toString(), options);
		} catch {
			url = null;
		}
	}

	if (!posting) {
		const fields: ClipFields = {
			...EMPTY_FIELDS,
			title: guessedTitle,
			company: guessedCompany,
			url: url ?? "",
			description: mainText,
		};
		return { origin: guessedTitle || guessedCompany || mainText ? "guess" : "none", fields };
	}

	const body = cleanBlock(descriptionText(asText(posting.description)), MAX_DESCRIPTION_CHARS) || mainText;
	const details = detailsOf(posting);
	return {
		origin: "page",
		fields: {
			title: line(posting.title ?? posting.name) || guessedTitle,
			company: nameOf(posting.hiringOrganization) || guessedCompany,
			location: locationOf(posting),
			salary: salaryOf(posting.baseSalary),
			url: url ?? "",
			description: cleanBlock(details ? `${details}\n\n${body}` : body, MAX_DESCRIPTION_CHARS),
		},
	};
}
