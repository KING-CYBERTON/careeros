// CAREEROS (P5-T03): the reader. `readPageInTab` is the one small function the popup injects into the active tab with
// `chrome.scripting.executeScript` (permissions `activeTab` and `scripting`, nothing new). Chrome serializes it and runs it
// in the extension's own isolated world: it runs none of the page's scripts, adds no listener, changes nothing, and hands
// back plain data only, strings. It reads text (`textContent`, attribute values), never `innerHTML`.
//
// The page is hostile until proven otherwise, so every read is bounded: at most 20 JSON-LD blocks of at most 500,000
// characters, at most 40 candidate blocks and 200,000 text nodes for the description, an iterative walk (a deeply nested
// page cannot overflow the stack), and every string cut to a cap before it leaves the page. Parsing and mapping happen in
// the popup (posting.ts), where they are tested without a browser.
//
// This function is serialized with `toString()`: it must stay self-contained (no imports, no module-level names).

/** What the reader returns. Every value is a string; `jsonLd` holds the raw text of each JSON-LD block. */
export type RawPage = {
	url: string;
	title: string;
	ogTitle: string;
	ogSiteName: string;
	/** Other meta values that may name the company, in order of preference. */
	metaCompany: string[];
	h1: string;
	mainText: string;
	jsonLd: string[];
};

export function readPageInTab(): RawPage {
	const FIELD_CHARS = 600;
	const MAIN_TEXT_CHARS = 60_000;
	const JSON_LD_BLOCKS = 20;
	const JSON_LD_CHARS = 500_000;
	const CANDIDATES = 40;
	const TEXT_NODES = 200_000;
	const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT", "OPTION", "IFRAME", "SVG"]);
	const BLOCKS = new Set([
		"P",
		"DIV",
		"LI",
		"UL",
		"OL",
		"H1",
		"H2",
		"H3",
		"H4",
		"H5",
		"H6",
		"TR",
		"SECTION",
		"ARTICLE",
		"BR",
		"HEADER",
		"FOOTER",
		"MAIN",
	]);

	const cut = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");
	const meta = (selector: string): string => {
		const element = document.querySelector(selector);
		return cut(element?.getAttribute("content"), FIELD_CHARS).trim();
	};

	/** The visible-ish text under `root`, whitespace collapsed, line breaks at block boundaries, at most `budget` characters. */
	const textOf = (root: Element, budget: number): string => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const parts: string[] = [];
		let length = 0;
		let visited = 0;
		let lastBlock: Element | null = null;
		for (
			let node = walker.nextNode();
			node !== null && length < budget && visited < TEXT_NODES;
			node = walker.nextNode()
		) {
			visited += 1;
			const parent = node.parentElement;
			if (!parent || SKIPPED.has(parent.tagName.toUpperCase())) continue;
			const text = cut(node.nodeValue, budget).replace(/\s+/g, " ").trim();
			if (text === "") continue;
			const separator =
				parts.length === 0 ? "" : BLOCKS.has(parent.tagName.toUpperCase()) && parent !== lastBlock ? "\n" : " ";
			if (BLOCKS.has(parent.tagName.toUpperCase())) lastBlock = parent;
			parts.push(separator, text);
			length += separator.length + text.length;
		}
		return parts.join("").slice(0, budget);
	};

	const jsonLd: string[] = [];
	for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json" i]')).slice(
		0,
		JSON_LD_BLOCKS,
	)) {
		const text = script.textContent ?? "";
		if (text.length > 0 && text.length <= JSON_LD_CHARS) jsonLd.push(text);
	}

	// The description comes from the largest of the page's main blocks (or the body when it has none).
	let mainText = "";
	const candidates = Array.from(document.querySelectorAll('main, article, [role="main"]')).slice(0, CANDIDATES);
	if (candidates.length === 0 && document.body) candidates.push(document.body);
	for (const candidate of candidates) {
		const text = textOf(candidate, MAIN_TEXT_CHARS);
		if (text.length > mainText.length) mainText = text;
	}

	return {
		url: cut(location.href, 4096),
		title: cut(document.title, FIELD_CHARS).trim(),
		ogTitle: meta('meta[property="og:title" i], meta[name="og:title" i]'),
		ogSiteName: meta('meta[property="og:site_name" i], meta[name="og:site_name" i]'),
		metaCompany: [
			meta('meta[name="application-name" i]'),
			meta('meta[name="twitter:site" i]'),
			meta('meta[name="author" i]'),
		].filter((value) => value !== ""),
		h1: cut(document.querySelector("h1")?.textContent, FIELD_CHARS).replace(/\s+/g, " ").trim(),
		mainText,
		jsonLd,
	};
}

/** The reader's answer is read as untrusted too: anything that is not the expected shape is `null`. */
export function readRawPage(value: unknown): RawPage | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
	if (typeof record.url !== "string") return null;
	const list = (key: string): string[] =>
		Array.isArray(record[key])
			? (record[key] as unknown[]).filter((item): item is string => typeof item === "string")
			: [];
	return {
		url: text("url"),
		title: text("title"),
		ogTitle: text("ogTitle"),
		ogSiteName: text("ogSiteName"),
		metaCompany: list("metaCompany").slice(0, 8),
		h1: text("h1"),
		mainText: text("mainText"),
		jsonLd: list("jsonLd").slice(0, 20),
	};
}
