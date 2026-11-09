import type { BuiltInTemplate } from "./built-ins";
import type { EmailTemplateKind, TemplateSource } from "./schema";
import type { ApplicationStatus } from "@reactive-resume/schema/applications/data";
import { BUILT_IN_TEMPLATES } from "./built-ins";

// CAREEROS (P5-T04): which templates a member sees. Pure, so the server, the web app and the phone app agree.

/** One row of the list a member picks from. */
export type TemplateEntry = {
	/** The row id, or `builtin:<kind>` for a built-in. */
	id: string;
	source: TemplateSource;
	kind: EmailTemplateKind;
	/** The stages it suggests itself for. Empty means any stage. */
	stageCategories: ApplicationStatus[];
	name: string;
	subject: string;
	body: string;
};

export type StoredTemplate = {
	id: string;
	kind: EmailTemplateKind;
	stageCategory: ApplicationStatus | null;
	name: string;
	subject: string;
	body: string;
};

const fromStored = (row: StoredTemplate, source: "org" | "mine"): TemplateEntry => ({
	id: row.id,
	source,
	kind: row.kind,
	stageCategories: row.stageCategory ? [row.stageCategory] : [],
	name: row.name,
	subject: row.subject,
	body: row.body,
});

const fromBuiltIn = (item: BuiltInTemplate): TemplateEntry => ({
	id: item.id,
	source: "builtin",
	kind: item.kind,
	stageCategories: [...item.stageCategories],
	name: item.name,
	subject: item.subject,
	body: item.body,
});

/**
 * The list of a member: their own templates, the organization's defaults, and a built-in for every kind the
 * organization has not customised (an organization default of a kind replaces the built-in of that kind).
 * `org` holds only active (not archived) defaults.
 */
export function resolveTemplates(input: {
	org: readonly StoredTemplate[];
	mine: readonly StoredTemplate[];
}): TemplateEntry[] {
	const customised = new Set(input.org.map((row) => row.kind));
	return [
		...input.mine.map((row) => fromStored(row, "mine")),
		...input.org.map((row) => fromStored(row, "org")),
		...BUILT_IN_TEMPLATES.filter((item) => !customised.has(item.kind)).map(fromBuiltIn),
	];
}

const PRECEDENCE: Record<TemplateSource, number> = { mine: 0, org: 1, builtin: 2 };

/** Does the template suggest itself for this stage? A template with no stage suits every stage. */
export const suitsStage = (
	entry: { stageCategories: readonly ApplicationStatus[] },
	stage: ApplicationStatus,
): boolean => entry.stageCategories.length === 0 || entry.stageCategories.includes(stage);

/** The templates to offer for a stage, best first: the stage's own suggestions before any-stage ones, then mine, then
 * the organization's, then the built-in. */
export function templatesForStage(entries: readonly TemplateEntry[], stage: ApplicationStatus): TemplateEntry[] {
	// A copy sorted with `sort` (not `toSorted`): the phone's JavaScript engine is older than the server's.
	return entries
		.filter((entry) => suitsStage(entry, stage))
		.sort((a, b) => {
			const specific = Number(a.stageCategories.length === 0) - Number(b.stageCategories.length === 0);
			return specific || PRECEDENCE[a.source] - PRECEDENCE[b.source];
		});
}

/** The template a stage opens on: mine, else the organization's, else the built-in. */
export const defaultForStage = (
	entries: readonly TemplateEntry[],
	stage: ApplicationStatus,
): TemplateEntry | undefined => templatesForStage(entries, stage)[0];
