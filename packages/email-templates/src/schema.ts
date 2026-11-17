import z from "zod";
import { applicationStatusSchema } from "@reactive-resume/schema/applications/data";

// CAREEROS (P5-T04): the rules for an email template, in one place for the server and both clients, so a limit changed
// here changes the API and the editors together. Pure: no database, no DOM.

/** The four stages a member writes at, plus a template of their own with no fixed purpose. */
export const TEMPLATE_KINDS = ["follow_up", "thank_you", "networking", "negotiation", "custom"] as const;
export type EmailTemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Where a template in a list comes from. `builtin` is shipped with the product, `org` is set by an organization's
 * owners and admins, `mine` is the caller's own. */
export const TEMPLATE_SOURCES = ["builtin", "org", "mine"] as const;
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number];

export const MAX_NAME_LENGTH = 100;
export const MAX_SUBJECT_LENGTH = 300;
export const MAX_BODY_LENGTH = 10_000;

/** The id prefix of a built-in template. Stored templates never have it: the database ids are random strings. */
export const BUILT_IN_ID_PREFIX = "builtin:";

export const templateKindSchema = z.enum(TEMPLATE_KINDS);

/** The application stages a template can suggest itself for (the six stage categories of the tracker). */
export const stageCategorySchema = applicationStatusSchema;

export const templateNameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);
export const templateSubjectSchema = z.string().trim().min(1).max(MAX_SUBJECT_LENGTH);
export const templateBodySchema = z.string().max(MAX_BODY_LENGTH);

/** The fields of a template a person writes. The organization and the owner are never fields. */
export const templateFields = {
	kind: templateKindSchema,
	stageCategory: stageCategorySchema.nullable().optional().describe("The application stage it suggests itself for."),
	name: templateNameSchema,
	subject: templateSubjectSchema,
	body: templateBodySchema.describe("Plain text. {{firstName}} style variables are filled in when it is used."),
};
