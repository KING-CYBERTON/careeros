// CAREEROS (P5-T01): every string the popup shows, in one module. Lingui is not used yet (see docs/questions.md Q234).
import type { AddressError } from "../lib/address";
import type { BrandingError } from "../lib/branding";

export const strings = {
	appName: "Job Clipper",
	loading: "Loading…",

	setupTitle: "Connect to your organization",
	setupIntro:
		"Job Clipper saves job postings to your organization's job tracker. Enter the address your organization uses.",
	addressLabel: "Your organization's address",
	addressPlaceholder: "careers.example.org",
	connect: "Connect",
	checking: "Checking…",
	waitingForPermission: "Waiting for your permission…",
	permissionNote:
		"After you confirm, your browser asks to let Job Clipper reach this one address. It never asks for all websites.",

	confirmTitle: "Is this your organization?",
	confirm: "Yes, connect",
	back: "Back",

	signInPlaceholder: "Sign in",
	signInNote: "Sign-in is coming soon. You will sign in to this organization here.",
	clipTitle: "Clip this job",
	clipPlaceholder: "Clipping the job on this page is coming soon.",
	changeOrganization: "Change organization",
	connectedTo: "Connected to",
	logoAlt: (orgName: string) => `${orgName} logo`,

	saveFailed: "Could not save the connection. Try again.",

	permissionDenied:
		"Permission was not granted, so Job Clipper cannot connect to this organization. Choose Yes, connect and allow access.",
	address: {
		empty: "Enter your organization's address.",
		invalid: "That does not look like a web address.",
		scheme: "Use an https:// address.",
		credentials: "Leave out any user name or password.",
		insecure: "Use an https:// address. Plain http is not accepted.",
		host: "Use your organization's domain name, for example careers.example.org.",
	} satisfies Record<AddressError, string>,
	branding: {
		unreachable: "Could not reach that address. Check it and your connection, then try again.",
		not_careeros: "That address is not a supported organization address. Check it with your organization.",
		no_organization: "That address does not belong to an organization. Use the address your organization gave you.",
	} satisfies Record<BrandingError, string>,
} as const;
