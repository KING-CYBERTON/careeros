import type { BuiltInKind, TemplateEntry } from "@careeros/email-templates";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// CAREEROS (P5-T04): the four built-in templates, as translatable messages. The English source lives in
// `@careeros/email-templates` (the server has no catalogs, so it answers with that); this is the same text for the
// screen, so a person sees it in their own language. `built-in-text.test.ts` keeps the two identical. The variables
// are passed in as values (`{role}` in the message), so a translator never sees or breaks the double braces; the value
// is the literal `{{role}}` that the renderer fills in later.

const firstName = "{{firstName}}";
const fullName = "{{fullName}}";
const company = "{{company}}";
const role = "{{role}}";
const contactName = "{{contactName}}";
const interviewDate = "{{interviewDate}}";
const myEmail = "{{myEmail}}";

type BuiltInText = { name: MessageDescriptor; subject: MessageDescriptor; body: MessageDescriptor };

const BUILT_IN_TEXT: Record<BuiltInKind, BuiltInText> = {
	follow_up: {
		name: msg`Follow up after applying`,
		subject: msg`Following up on my ${role} application`,
		body: msg`Hello ${contactName},

I applied for the ${role} position at ${company} and wanted to ask where my application stands. I am still very interested in the role, and I would be glad to send anything that would help your review.

Thank you for your time.

${fullName}
${myEmail}`,
	},
	thank_you: {
		name: msg`Thank you after an interview`,
		subject: msg`Thank you for meeting with me on ${interviewDate}`,
		body: msg`Hello ${contactName},

Thank you for taking the time to meet with me on ${interviewDate} about the ${role} role at ${company}. Our conversation left me more excited about the work, and I would welcome the chance to take the next step.

If there is anything I can send to help with your decision, just let me know.

Best regards,
${fullName}
${myEmail}`,
	},
	networking: {
		name: msg`Reach out to someone at the company`,
		subject: msg`A question about working at ${company}`,
		body: msg`Hello ${contactName},

My name is ${fullName}, and I am looking at ${role} opportunities at ${company}. I admire what your team is building, and I would value ten minutes of your time to hear how you got started there and what the team looks for.

I know your days are full, so please say no if the timing is wrong. Any pointer you can share would help.

Kind regards,
${firstName}
${myEmail}`,
	},
	negotiation: {
		name: msg`Respond to an offer`,
		subject: msg`Next steps on the ${role} offer`,
		body: msg`Hello ${contactName},

Thank you for offering me the ${role} position at ${company}. I am glad to be considered and I am excited about joining the team. Before I accept, I would like to talk through the pay and the start date. Given the scope of the role and my experience, I would like to discuss [the terms you have in mind].

Could we find a time this week to go through it together?

With thanks,
${fullName}
${myEmail}`,
	},
};

/** The built-in templates' text in the language of `i18n`; any other entry is returned as it is. */
export function translateTemplate<
	T extends Pick<TemplateEntry, "id" | "source" | "kind" | "name" | "subject" | "body">,
>(i18n: I18n, entry: T): T {
	if (entry.source !== "builtin" || entry.kind === "custom") return entry;
	const text = BUILT_IN_TEXT[entry.kind];
	return { ...entry, name: i18n._(text.name), subject: i18n._(text.subject), body: i18n._(text.body) };
}
