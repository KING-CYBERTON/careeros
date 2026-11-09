import {
	stageCategorySchema,
	TEMPLATE_SOURCES,
	templateBodySchema,
	templateFields,
	templateKindSchema,
	templateSubjectSchema,
	VARIABLE_NAMES,
} from "@careeros/email-templates";
import z from "zod";

// CAREEROS (P5-T04): inputs and outputs of the email template procedures. The organization and the owner are never
// fields: they are the organization the request resolved and the signed-in member. The limits come from
// `@careeros/email-templates`, so the editors on the web and the phone and the API share them.

const id = z.string().min(1).max(64);

export const templateEntrySchema = z.object({
	id: z.string().describe("The template id, or builtin:<kind> for one shipped with the product."),
	source: z
		.enum(TEMPLATE_SOURCES)
		.describe("builtin: shipped with the product. org: set by the organization. mine: yours."),
	kind: templateKindSchema,
	stageCategories: z.array(stageCategorySchema).describe("The application stages it suggests itself for. Empty: any."),
	name: z.string(),
	subject: z.string(),
	body: z.string(),
});

export const templateCreateInput = z.object(templateFields);

export const templateUpdateInput = z.object({
	id,
	kind: templateFields.kind.optional(),
	stageCategory: templateFields.stageCategory,
	name: templateFields.name.optional(),
	subject: templateFields.subject.optional(),
	body: templateFields.body.optional(),
});

export const templateArchiveInput = z.object({ id });
export const templateArchiveOutput = z.object({ id: z.string() });

export const renderInput = z.object({
	templateId: id.describe("A template of yours, an organization default, or builtin:<kind>."),
	applicationId: id.describe("One of your own applications."),
	locale: z.string().trim().min(2).max(35).optional().describe("A BCP 47 language tag for the interview date."),
	source: z
		.object({ subject: templateSubjectSchema, body: templateBodySchema })
		.optional()
		.describe("Only for a built-in: the text to use in place of its English source, so it can be shown translated."),
});

export const renderOutput = z.object({
	subject: z.string(),
	body: z.string(),
	to: z.string().nullable().describe("The contact's email address, when it is known."),
	missing: z.array(z.enum(VARIABLE_NAMES)).describe("The variables the template uses that had no value to fill in."),
});

export type TemplateCreateInput = z.infer<typeof templateCreateInput>;
export type TemplateUpdateInput = z.infer<typeof templateUpdateInput>;
export type RenderInput = z.infer<typeof renderInput>;
