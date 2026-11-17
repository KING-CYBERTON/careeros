import { randomBytes, randomUUID } from "node:crypto";
import { bustHostCache, parseOrgHostPattern, platformHostsFromEnv } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
import { requireOrganizationAdmin } from "../branding/service";
import { normalizeHostname, ownHosts } from "../custom-domain/service";
import { txtName, txtValue } from "./dns";
import { checkDomain, defaultProcessDeps, startRemoval, type OrganizationDomainRow } from "./process";

// CAREEROS (P2-T06): the operations an owner or admin has on their organization's custom domains. Every query runs in
// the request's organization scope, so row-level security confines it; the organization id is never an input.

export type DnsRecord = { type: "TXT" | "CNAME"; name: string; value: string };

export const isOrgDomainsConfigured = () =>
	Boolean(env.CF_SAAS_API_TOKEN && env.CF_ZONE_ID && env.CF_SAAS_CNAME_TARGET);

/** The records to create where the domain's DNS is managed: the ownership proof and the Cloudflare for SaaS CNAME. */
export function dnsRecords(row: Pick<OrganizationDomainRow, "hostname" | "verificationToken">): DnsRecord[] {
	return [
		{ type: "TXT", name: txtName(row.hostname), value: txtValue(row.verificationToken) },
		{ type: "CNAME", name: row.hostname, value: env.CF_SAAS_CNAME_TARGET ?? "" },
	];
}

export function toDomainDto(row: OrganizationDomainRow) {
	return {
		id: row.id,
		hostname: row.hostname,
		status: row.status as schema.OrganizationDomainStatus,
		records: dnsRecords(row),
		cfSslStatus: row.cfSslStatus,
		failureReason: row.failureReason,
		lastCheckedAt: row.lastCheckedAt,
		verifiedAt: row.verifiedAt,
		createdAt: row.createdAt,
	};
}

const assertConfigured = () => {
	if (!isOrgDomainsConfigured())
		throw new ORPCError("PRECONDITION_FAILED", {
			status: 412,
			message: "Custom domains for organizations aren't set up on this server.",
		});
};

/** The text of an error and of everything it wraps (the driver's error sits under Drizzle's). */
function errorText(error: unknown): string {
	const parts: string[] = [];
	for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; depth++) {
		parts.push(current.message);
		current = current.cause;
	}
	return parts.join("\n");
}

function claimFailure(error: unknown): ORPCError<string, unknown> | undefined {
	const text = errorText(error);
	// The message never says who holds a taken name: the same answer for another organization and for a personal domain.
	if (
		text.includes("careeros_org_domain:hostname_taken") ||
		text.includes("organization_domain_org_hostname_key") ||
		text.includes("organization_domain_proven_hostname_key")
	)
		return new ORPCError("CONFLICT", { message: "That domain isn't available.", data: { code: "DOMAIN_UNAVAILABLE" } });
	if (text.includes("careeros_org_domain:reserved_host") || text.includes("careeros_org_domain:invalid_hostname"))
		return new ORPCError("BAD_REQUEST", {
			message: "That domain can't be used. Enter a domain you own, such as careers.example.com.",
			data: { code: "INVALID_DOMAIN" },
		});
	if (text.includes("careeros_org_domain:domain_limit"))
		return new ORPCError("CONFLICT", {
			message: `An organization can have at most ${schema.ORGANIZATION_DOMAIN_LIMIT} domains.`,
			data: { code: "DOMAIN_LIMIT" },
		});
	return undefined;
}

/** Hosts a custom domain may never be: the platform's own, its aliases, the targets, and what is under them. */
function reservedHosts(): string[] {
	return [
		...new Set([
			...ownHosts(),
			...platformHostsFromEnv(),
			...(env.CF_SAAS_CNAME_TARGET ? [env.CF_SAAS_CNAME_TARGET] : []),
		]),
	];
}

export async function listDomains(userId: string) {
	const organizationId = await requireOrganizationAdmin(userId);
	const rows = await db
		.select()
		.from(schema.organizationDomain)
		.where(eq(schema.organizationDomain.organizationId, organizationId))
		.orderBy(asc(schema.organizationDomain.createdAt), asc(schema.organizationDomain.id));
	return rows.map(toDomainDto);
}

export async function addDomain(userId: string, input: string) {
	const organizationId = await requireOrganizationAdmin(userId);
	assertConfigured();
	const hostname = normalizeHostname(input);
	if (!hostname)
		throw new ORPCError("BAD_REQUEST", {
			message: "That domain can't be used. Enter a domain you own, such as careers.example.com.",
			data: { code: "INVALID_DOMAIN" },
		});

	const own = await db
		.select({ id: schema.organizationDomain.id, hostname: schema.organizationDomain.hostname })
		.from(schema.organizationDomain)
		.where(eq(schema.organizationDomain.organizationId, organizationId));
	if (own.some((row) => row.hostname === hostname))
		throw new ORPCError("CONFLICT", {
			message: "This organization has already added that domain.",
			data: { code: "DOMAIN_EXISTS" },
		});
	if (own.length >= schema.ORGANIZATION_DOMAIN_LIMIT)
		throw new ORPCError("CONFLICT", {
			message: `An organization can have at most ${schema.ORGANIZATION_DOMAIN_LIMIT} domains.`,
			data: { code: "DOMAIN_LIMIT" },
		});

	const id = randomUUID();
	const pattern = parseOrgHostPattern(env.ORG_HOST_PATTERN);
	const reserved = reservedHosts();
	try {
		// One definer function does the claim: it sees every organization's domains and every user's custom domain.
		await db.execute(
			sql`select careeros_claim_org_domain(
				${organizationId}::text, ${id}::text, ${hostname}::text, ${randomBytes(24).toString("base64url")}::text,
				${userId}::text, ARRAY[${sql.join(
					reserved.map((host) => sql`${host}`),
					sql`, `,
				)}]::text[],
				${pattern?.prefix ?? null}::text, ${pattern?.suffix ?? null}::text)`,
		);
	} catch (error) {
		throw claimFailure(error) ?? error;
	}
	// A name that might be negatively cached as unknown can now be a pending domain (still not resolving).
	bustHostCache({ hostname });
	const [row] = await db.select().from(schema.organizationDomain).where(eq(schema.organizationDomain.id, id));
	if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR");
	return toDomainDto(row);
}

async function findDomain(organizationId: string, id: string): Promise<OrganizationDomainRow> {
	const [row] = await db
		.select()
		.from(schema.organizationDomain)
		.where(and(eq(schema.organizationDomain.id, id), eq(schema.organizationDomain.organizationId, organizationId)));
	// Row-level security already hides another organization's row: it is NOT_FOUND, the same as an id that does not exist.
	if (!row) throw new ORPCError("NOT_FOUND", { message: "No such domain." });
	return row;
}

/** Checks the domain now. At most one check a minute per domain. */
export async function recheckDomain(userId: string, id: string) {
	const organizationId = await requireOrganizationAdmin(userId);
	// An id of another organization is NOT_FOUND whether or not Cloudflare is set up: look before reporting settings.
	const row = await findDomain(organizationId, id);
	assertConfigured();
	if (row.status === "failed")
		throw new ORPCError("CONFLICT", {
			message: "This domain failed. Remove it and add it again.",
			data: { code: "DOMAIN_FAILED" },
		});
	if (row.status === "removing")
		throw new ORPCError("CONFLICT", { message: "This domain is being removed.", data: { code: "DOMAIN_REMOVING" } });
	const result = await checkDomain(organizationId, id, "manual", defaultProcessDeps());
	if (!result.leased)
		throw new ORPCError("TOO_MANY_REQUESTS", {
			status: 429,
			message: "This domain was checked a moment ago. Try again in a minute.",
		});
	if (!result.row) throw new ORPCError("NOT_FOUND", { message: "No such domain." });
	return toDomainDto(result.row);
}

/** Stops the domain resolving at once, then deletes it at Cloudflare and removes the row. */
export async function removeDomain(userId: string, id: string) {
	const organizationId = await requireOrganizationAdmin(userId);
	await findDomain(organizationId, id);
	// Without Cloudflare configured the row stays `removing` (it no longer resolves) until the job can delete it.
	await startRemoval(organizationId, id, defaultProcessDeps());
}

/**
 * CAREEROS (P2-T07): what the Domains screen needs besides the list. The address that always works comes from
 * `ORG_HOST_PATTERN` and the organization's own slug (read in its scope); whether domains can be added at all depends
 * on the server's Cloudflare settings.
 */
export async function getDomainInfo(userId: string) {
	const organizationId = await requireOrganizationAdmin(userId);
	const [organization] = await db
		.select({ slug: schema.organization.slug })
		.from(schema.organization)
		.where(eq(schema.organization.id, organizationId))
		.limit(1);
	const pattern = parseOrgHostPattern(env.ORG_HOST_PATTERN);
	const subdomainHost = pattern && organization?.slug ? `${pattern.prefix}${organization.slug}${pattern.suffix}` : null;
	const appUrl = new URL(env.APP_URL);
	return {
		subdomainHost,
		subdomainUrl: subdomainHost ? `${appUrl.protocol}//${subdomainHost}${appUrl.port ? `:${appUrl.port}` : ""}` : null,
		domainsConfigured: isOrgDomainsConfigured(),
		domainLimit: schema.ORGANIZATION_DOMAIN_LIMIT,
	};
}
