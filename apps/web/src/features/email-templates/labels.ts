import type { EmailTemplateKind } from "@careeros/email-templates";
import { t } from "@lingui/core/macro";

// CAREEROS (P5-T04): the words for the kinds of email template and for where each one comes from.

export const getKindLabel = (kind: EmailTemplateKind) =>
	({
		follow_up: t`Follow-up`,
		thank_you: t`Thank-you`,
		networking: t`Networking`,
		negotiation: t`Negotiation`,
		custom: t`Custom`,
	})[kind];

export const getSourceLabel = (source: "builtin" | "org" | "mine") =>
	({ builtin: t`Built-in`, org: t`Organization`, mine: t`Mine` })[source];
