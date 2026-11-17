import type { EmailTemplateKind } from "./schema";
import type { ApplicationStatus } from "@reactive-resume/schema/applications/data";
import { BUILT_IN_ID_PREFIX } from "./schema";

// CAREEROS (P5-T04): the four templates shipped with the product, one per kind, written for CareerOS. This is the
// English source. The web and mobile apps carry the same text as Lingui messages (`built-in-text.ts` in each) and a
// test in each keeps the two identical, so a person sees these in their own language while the server, which has no
// catalogs, still answers with the source.

export type BuiltInKind = Exclude<EmailTemplateKind, "custom">;

export type BuiltInTemplate = {
	/** `builtin:<kind>`: never the id of a stored row. */
	id: string;
	kind: BuiltInKind;
	/** The stages it suggests itself for, in the order a person is likely to need it. */
	stageCategories: readonly ApplicationStatus[];
	name: string;
	subject: string;
	body: string;
};

export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
	{
		id: `${BUILT_IN_ID_PREFIX}follow_up`,
		kind: "follow_up",
		stageCategories: ["applied", "screening"],
		name: "Follow up after applying",
		subject: "Following up on my {{role}} application",
		body: `Hello {{contactName}},

I applied for the {{role}} position at {{company}} and wanted to ask where my application stands. I am still very interested in the role, and I would be glad to send anything that would help your review.

Thank you for your time.

{{fullName}}
{{myEmail}}`,
	},
	{
		id: `${BUILT_IN_ID_PREFIX}thank_you`,
		kind: "thank_you",
		stageCategories: ["interview", "screening"],
		name: "Thank you after an interview",
		subject: "Thank you for meeting with me on {{interviewDate}}",
		body: `Hello {{contactName}},

Thank you for taking the time to meet with me on {{interviewDate}} about the {{role}} role at {{company}}. Our conversation left me more excited about the work, and I would welcome the chance to take the next step.

If there is anything I can send to help with your decision, just let me know.

Best regards,
{{fullName}}
{{myEmail}}`,
	},
	{
		id: `${BUILT_IN_ID_PREFIX}networking`,
		kind: "networking",
		stageCategories: ["saved"],
		name: "Reach out to someone at the company",
		subject: "A question about working at {{company}}",
		body: `Hello {{contactName}},

My name is {{fullName}}, and I am looking at {{role}} opportunities at {{company}}. I admire what your team is building, and I would value ten minutes of your time to hear how you got started there and what the team looks for.

I know your days are full, so please say no if the timing is wrong. Any pointer you can share would help.

Kind regards,
{{firstName}}
{{myEmail}}`,
	},
	{
		id: `${BUILT_IN_ID_PREFIX}negotiation`,
		kind: "negotiation",
		stageCategories: ["offer"],
		name: "Respond to an offer",
		subject: "Next steps on the {{role}} offer",
		body: `Hello {{contactName}},

Thank you for offering me the {{role}} position at {{company}}. I am glad to be considered and I am excited about joining the team. Before I accept, I would like to talk through the pay and the start date. Given the scope of the role and my experience, I would like to discuss [the terms you have in mind].

Could we find a time this week to go through it together?

With thanks,
{{fullName}}
{{myEmail}}`,
	},
];

export const isBuiltInId = (id: string): boolean => id.startsWith(BUILT_IN_ID_PREFIX);

export const builtInById = (id: string): BuiltInTemplate | undefined =>
	BUILT_IN_TEMPLATES.find((item) => item.id === id);

export const builtInForKind = (kind: BuiltInKind): BuiltInTemplate => {
	const found = BUILT_IN_TEMPLATES.find((item) => item.kind === kind);
	if (!found) throw new Error(`No built-in template for ${kind}`);
	return found;
};
