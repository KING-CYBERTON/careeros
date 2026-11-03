// CAREEROS (P6-T01, G10): the legal drafts are bundled at build time from docs/legal; nothing is fetched at runtime.
// The production Docker build copies docs/legal into the build stage (Dockerfile) and turbo hashes it for `web#build`.
// @boundaries-ignore the legal drafts live in the repository's docs/, outside any workspace package
import dpaSource from "../../../../../docs/legal/dpa.md?raw";
// @boundaries-ignore the legal drafts live in the repository's docs/, outside any workspace package
import privacySource from "../../../../../docs/legal/privacy.md?raw";
// @boundaries-ignore the legal drafts live in the repository's docs/, outside any workspace package
import termsSource from "../../../../../docs/legal/terms.md?raw";

export type LegalDocumentId = "terms" | "privacy" | "dpa";

/**
 * Each Markdown file opens with its title and then a draft banner written as a block quote. The page shows its own
 * banner while the texts are unapproved (`LEGAL_PAGES_APPROVED`), so the quote is cut from the body here and is never
 * shown twice. Only a block quote directly under the title is removed.
 */
export function stripDraftBanner(markdown: string): string {
	const lines = markdown.split("\n");
	const title = lines.findIndex((line) => line.trim() !== "");
	if (title === -1 || !lines[title]?.startsWith("# ")) return markdown;
	let start = title + 1;
	while (start < lines.length && lines[start]?.trim() === "") start += 1;
	let end = start;
	while (end < lines.length && lines[end]?.startsWith(">")) end += 1;
	if (end === start) return markdown;
	return [...lines.slice(0, title + 1), "", ...lines.slice(end)].join("\n").replaceAll(/\n{3,}/g, "\n\n");
}

export const legalDocuments: Record<LegalDocumentId, string> = {
	terms: stripDraftBanner(termsSource),
	privacy: stripDraftBanner(privacySource),
	dpa: stripDraftBanner(dpaSource),
};
