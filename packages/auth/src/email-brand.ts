import type { EmailBrand } from "@reactive-resume/email/brand";
import {
	matchOrgHost,
	parseOrgHostPattern,
	readEmailBrandingCache,
	resolveHost,
	type HostContext,
} from "@careeros/tenancy";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { cleanAppName, cleanDisplayName, DEFAULT_EMAIL_BRAND, safeReplyTo } from "@reactive-resume/email/brand";
import { env } from "@reactive-resume/env/server";
import { isHexColor, readableForeground } from "@reactive-resume/utils/brand";

// CAREEROS (P2-T04, phase plan D8): which organization an email is about, what its brand is, and which origin its
// links use. Better Auth calls the email callbacks from `config.ts` and `organization.ts`; the career notification job
// (`packages/api`) calls this module too. It lives in `packages/auth` because the import graph has `api` above `auth`.
//
// Rules, in short:
//   * invitation              -> the inviting organization.
//   * verify / reset / change -> the organization of the request's host (T03 `HostContext`), when it is an org host;
//                                otherwise the platform default. Never the user's memberships: a member of two
//                                organizations would otherwise get one organization's brand on the other's host.
//   * career notification     -> the organization of the row the notice is about.
// A missing request, an unknown host or a failed lookup all mean "platform default"; nothing here throws.

export type EmailBrandOrgInput =
	| { source: "invitation"; organizationId: string }
	| { source: "organization"; organizationId: string }
	| { source: "request"; request: Request | undefined };

async function hostOf(request: Request | undefined): Promise<HostContext | undefined> {
	if (!request) return undefined;
	try {
		return await resolveHost(request);
	} catch {
		return undefined;
	}
}

/** The organization id an email is branded for, or `null` for the platform default. */
export async function resolveEmailBrandOrg(input: EmailBrandOrgInput): Promise<string | null> {
	if (input.source !== "request") return input.organizationId || null;
	const host = await hostOf(input.request);
	return host?.kind === "org" ? host.organizationId : null;
}

type EmailBrandingRow = {
	organization_id: string;
	slug: string;
	app_name: string | null;
	logo_storage_key: string | null;
	primary_color: string | null;
	support_url: string | null;
	terms_url: string | null;
	privacy_url: string | null;
	email_from_name: string | null;
	email_reply_to: string | null;
};

/** One organization's email branding through the definer function, cached for 60 s. `null` for an unknown organization. */
export function loadEmailBranding(organizationId: string): Promise<EmailBrandingRow | null> {
	return readEmailBrandingCache(organizationId, async () => {
		const { rows } = await db.execute<EmailBrandingRow>(
			sql`select * from careeros_email_branding(${organizationId}::text)`,
		);
		return rows[0] ?? null;
	});
}

/**
 * The origin of an organization's own subdomain host (`ORG_HOST_PATTERN` with its slug), with the scheme and port of
 * APP_URL; `undefined` when organization hosts are off or the slug does not fit the pattern. A subdomain of the
 * platform's wildcard is verified by construction. Custom domains are T06's and are not read here.
 */
export function orgSubdomainOrigin(slug: string): string | undefined {
	const pattern = parseOrgHostPattern(env.ORG_HOST_PATTERN);
	if (!pattern) return undefined;
	const hostname = `${pattern.prefix}${slug}${pattern.suffix}`;
	if (matchOrgHost(hostname, pattern) !== slug) return undefined;
	const app = new URL(env.APP_URL);
	return `${app.protocol}//${hostname}${app.port ? `:${app.port}` : ""}`;
}

const LOGO_EXTENSION = /\.(?:png|jpe?g)$/i;

export type EmailMessageContext = {
	organizationId: string | null;
	brand: EmailBrand;
	/** The sender display name; the address stays SMTP_FROM. `undefined` means the platform default. */
	fromName: string | undefined;
	replyTo: string | undefined;
	/** The origin action links use (rules at `buildEmailContext`). */
	linkOrigin: string;
};

/**
 * The brand, sender and link origin for one email.
 *
 * Link origin: the origin of the request's host when the `HostContext` says it is a verified organization host;
 * the inviting organization's own host for an invitation; APP_URL (the platform host) in every other case. The raw
 * `Host` and `X-Forwarded-Host` headers are never read here: `resolveHost` is the only reader, and it only honours
 * `X-Forwarded-Host` when TRUST_FORWARDED_HOST is on.
 */
export async function buildEmailContext(input: EmailBrandOrgInput): Promise<EmailMessageContext> {
	const platformOrigin = new URL(env.APP_URL).origin;
	const host = input.source === "request" ? await hostOf(input.request) : undefined;
	const organizationId = await resolveEmailBrandOrg(input);
	const requestOrigin = host?.kind === "org" ? host.origin : undefined;
	const fallback: EmailMessageContext = {
		organizationId: null,
		brand: DEFAULT_EMAIL_BRAND,
		fromName: undefined,
		replyTo: undefined,
		linkOrigin: requestOrigin ?? platformOrigin,
	};
	if (!organizationId) return fallback;

	let row: EmailBrandingRow | null;
	try {
		row = await loadEmailBranding(organizationId);
	} catch {
		// A failed lookup must not stop a password reset: send the platform brand. Nothing from the row is logged.
		return fallback;
	}
	if (!row) return fallback;

	const ownOrigin = requestOrigin ?? orgSubdomainOrigin(row.slug);
	const appName = cleanAppName(row.app_name);
	const primaryColor = isHexColor(row.primary_color) ? row.primary_color.toLowerCase() : undefined;
	const filename = row.logo_storage_key?.split("/").pop();
	const brand: EmailBrand = {
		appName,
		logoUrl:
			filename && LOGO_EXTENSION.test(filename)
				? new URL(`/api/branding-assets/${row.organization_id}/${filename}`, ownOrigin ?? platformOrigin).toString()
				: undefined,
		primaryColor,
		primaryForeground: primaryColor ? readableForeground(primaryColor) : undefined,
		supportUrl: row.support_url ?? undefined,
		privacyUrl: row.privacy_url ?? undefined,
		termsUrl: row.terms_url ?? undefined,
	};
	return {
		organizationId: row.organization_id,
		brand,
		fromName: cleanDisplayName(row.email_from_name) || cleanDisplayName(appName) || undefined,
		replyTo: safeReplyTo(row.email_reply_to),
		linkOrigin: input.source === "invitation" ? (ownOrigin ?? platformOrigin) : (requestOrigin ?? platformOrigin),
	};
}

/**
 * Replaces only the origin (scheme, host and port) of a link Better Auth built from its base URL. The path, the query
 * (the token) and the fragment are kept byte for byte. `origin` must come from `buildEmailContext`, never from input.
 */
export function withLinkOrigin(link: string, origin: string): string {
	const url = new URL(link);
	const target = new URL(origin);
	// Setting `host` alone would keep the old port when the target has none, so set the three parts one by one.
	url.protocol = target.protocol;
	url.hostname = target.hostname;
	url.port = target.port;
	return url.toString();
}
