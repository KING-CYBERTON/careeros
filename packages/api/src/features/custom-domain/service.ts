import { randomBytes } from "node:crypto";
import { resolve4, resolve6, resolveCname, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
// CAREEROS: custom domains belong to an organization (P1-T09)
import { requireOrgId, withOrgContext } from "@careeros/tenancy";
import { ORPCError } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";
import { env } from "@reactive-resume/env/server";
import { ownerIsNotBanned } from "../resume/access-policy";

const TXT_PREFIX = "_rx-verify";
const DAY_MS = 24 * 60 * 60 * 1000;
// A verified domain whose DNS stops pointing here keeps working this long, in case the owner is mid-change.
const GRACE_MS = 7 * DAY_MS;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isCustomDomainsEnabled = () => Boolean(env.CUSTOM_DOMAIN_TARGET && env.CUSTOM_DOMAIN_PROVIDER_SECRET);

let hosts: ReadonlySet<string> | undefined;
/** The app's own hostnames (APP_URL, APP_ALIAS_URL, the CNAME target): none of them, or anything under them, is a custom domain. */
export const ownHosts = (): ReadonlySet<string> =>
	(hosts ??= new Set(
		[env.APP_URL, env.APP_ALIAS_URL, env.CUSTOM_DOMAIN_TARGET && `https://${env.CUSTOM_DOMAIN_TARGET}`]
			.filter((value): value is string => Boolean(value))
			.map((value) => new URL(value).hostname),
	));

/**
 * A typed domain as the host DNS knows: lowercase ASCII, no scheme, path, port or trailing dot. `null` when it can't be
 * a public domain (an IP address, a single label, the app's own hosts).
 */
export function normalizeHostname(input: string): string | null {
	const value = input.trim();
	let ascii: string;
	try {
		// The URL parser lowercases, converts to punycode and drops the port, path, query and fragment.
		ascii = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`).hostname.replace(/\.$/, "");
	} catch {
		return null;
	}
	if (!ascii || ascii.length > 253 || isIP(ascii)) return null;
	const labels = ascii.split(".");
	if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
	if (!/^[a-z][a-z0-9-]*$/.test(labels.at(-1) ?? "")) return null;
	for (const own of ownHosts()) if (ascii === own || ascii.endsWith(`.${own}`)) return null;
	return ascii;
}

// CAREEROS (P2-T06): the `careeros_custom_domain_guard` trigger raises this when an organization holds the hostname.
function orgHoldsHostname(error: unknown): boolean {
	for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; depth++) {
		if (current.message.includes("careeros_org_domain:hostname_taken")) return true;
		current = current.cause;
	}
	return false;
}

const lookup = <T>(query: Promise<T[]>) => query.catch(() => [] as T[]);

const txtValue = (token: string) => `rx-verify=${token}`;

export type DnsRecord = { type: "A" | "AAAA" | "CNAME" | "TXT"; name: string; value: string };

/**
 * What to add where the domain's DNS is managed: a TXT record proving ownership, and a CNAME to the target. A root
 * domain can't have a CNAME, so it gets A and AAAA records with the target's addresses instead.
 */
async function connectionRecords(hostname: string, token: string): Promise<DnsRecord[]> {
	const target = env.CUSTOM_DOMAIN_TARGET ?? "";
	const proof: DnsRecord = { type: "TXT", name: `${TXT_PREFIX}.${hostname}`, value: txtValue(token) };
	// ponytail: two labels is a root domain; one under a two-part suffix (example.co.uk) gets the CNAME, and the
	// client's note explains the addresses. A public-suffix list would tell them apart.
	if (hostname.split(".").length === 2) {
		const [v4, v6] = await Promise.all([lookup(resolve4(target)), lookup(resolve6(target))]);
		const addresses = [
			...v4.map((value): DnsRecord => ({ type: "A", name: hostname, value })),
			...v6.map((value): DnsRecord => ({ type: "AAAA", name: hostname, value })),
		];
		if (addresses.length > 0) return [...addresses, proof];
	}
	return [{ type: "CNAME", name: hostname, value: target }, proof];
}

async function toStatus(domain: typeof schema.customDomain.$inferSelect) {
	return {
		hostname: domain.hostname,
		target: env.CUSTOM_DOMAIN_TARGET ?? "",
		txtName: `${TXT_PREFIX}.${domain.hostname}`,
		txtValue: txtValue(domain.verificationToken),
		records: await connectionRecords(domain.hostname, domain.verificationToken),
		verified: domain.verifiedAt !== null,
		lastCheckedAt: domain.lastCheckedAt,
	};
}

const assertEnabled = () => {
	if (!isCustomDomainsEnabled())
		throw new ORPCError("PRECONDITION_FAILED", {
			status: 412,
			message: "Custom domains aren't set up on this server.",
		});
};

/** Whether DNS proves `token`'s account owns `hostname` and points it at this server. */
async function dnsPointsHere(hostname: string, token: string): Promise<boolean> {
	const target = env.CUSTOM_DOMAIN_TARGET;
	if (!target) return false;
	const txt = (await lookup(resolveTxt(`${TXT_PREFIX}.${hostname}`))).map((parts) => parts.join(""));
	if (!txt.includes(txtValue(token))) return false;

	const cnames = (await lookup(resolveCname(hostname))).map((name) => name.toLowerCase().replace(/\.$/, ""));
	if (cnames.includes(target)) return true;
	// A root domain can't have a CNAME: its addresses must be the target's.
	const [own4, own6, target4, target6] = await Promise.all([
		lookup(resolve4(hostname)),
		lookup(resolve6(hostname)),
		lookup(resolve4(target)),
		lookup(resolve6(target)),
	]);
	const targets = new Set([...target4, ...target6]);
	const addresses = [...own4, ...own6];
	return addresses.length > 0 && addresses.every((address) => targets.has(address));
}

export const customDomainService = {
	get: async (userId: string) => {
		assertEnabled();
		const [domain] = await db.select().from(schema.customDomain).where(eq(schema.customDomain.userId, userId));
		return domain ? toStatus(domain) : null;
	},

	/** Claims a domain for the account, replacing its previous one. It works once `verify` sees the DNS records. */
	set: async (userId: string, input: string) => {
		assertEnabled();
		const hostname = normalizeHostname(input);
		if (!hostname)
			throw new ORPCError("INVALID_DOMAIN", { status: 400, message: "Enter a domain such as resume.example.com." });

		const [existing] = await db.select().from(schema.customDomain).where(eq(schema.customDomain.userId, userId));
		if (existing?.hostname === hostname) return toStatus(existing);

		const values = {
			hostname,
			verificationToken: randomBytes(16).toString("hex"),
			verifiedAt: null,
			lastCheckedAt: null,
			failingSince: null,
		};
		const [domain] = await db
			.insert(schema.customDomain)
			// CAREEROS: the tenant column comes from the request's organization, never from the client (P1-T09)
			.values({ organizationId: requireOrgId(), userId, ...values })
			.onConflictDoUpdate({ target: [schema.customDomain.organizationId, schema.customDomain.userId], set: values })
			.returning()
			// CAREEROS (P2-T06, D7): a trigger refuses a hostname an organization already holds as its custom domain.
			.catch((error: unknown) => {
				if (orgHoldsHostname(error))
					throw new ORPCError("CONFLICT", {
						message: "That domain isn't available.",
						data: { code: "DOMAIN_UNAVAILABLE" },
					});
				throw error;
			});
		if (!domain) throw new ORPCError("INTERNAL_SERVER_ERROR");
		return toStatus(domain);
	},

	/** Checks DNS now. Proof moves the domain from any other account that had it, since DNS shows who owns it today. */
	verify: async (userId: string) => {
		assertEnabled();
		const [domain] = await db.select().from(schema.customDomain).where(eq(schema.customDomain.userId, userId));
		if (!domain) throw new ORPCError("NOT_FOUND");

		const valid = await dnsPointsHere(domain.hostname, domain.verificationToken);
		const now = new Date();
		const updated = await db.transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(schema.customDomain)
				.where(
					and(
						eq(schema.customDomain.userId, userId),
						eq(schema.customDomain.hostname, domain.hostname),
						eq(schema.customDomain.verificationToken, domain.verificationToken),
					),
				)
				.for("update");
			if (!current)
				throw new ORPCError("CONFLICT", { message: "The domain changed during verification. Verify it again." });
			const failingSince = current.failingSince ?? now;
			// CAREEROS: other claimants live in other organizations, which row-level security hides, while the verified
			// hostname index is global. A definer function un-verifies them, for the current organization only (P1-T09).
			if (valid)
				await tx.execute(sql`select careeros_release_domain_claims(${domain.hostname}, ${requireOrgId()}, ${userId})`);
			const [row] = await tx
				.update(schema.customDomain)
				.set(
					valid
						? { verifiedAt: current.verifiedAt ?? now, lastCheckedAt: now, failingSince: null }
						: {
								lastCheckedAt: now,
								failingSince,
								...(now.getTime() - failingSince.getTime() > GRACE_MS ? { verifiedAt: null } : {}),
							},
				)
				.where(eq(schema.customDomain.userId, userId))
				.returning();
			return row;
		});
		if (!updated) throw new ORPCError("NOT_FOUND");
		return toStatus(updated);
	},

	remove: async (userId: string) => {
		assertEnabled();
		await db.delete(schema.customDomain).where(eq(schema.customDomain.userId, userId));
	},
};

/**
 * The resume owner's verified custom domain, as a column of a query on `resume`: where its primary resume lives for
 * search engines. Null when custom domains are off.
 */
export const verifiedDomainColumn = () =>
	isCustomDomainsEnabled()
		? // CAREEROS: public lookup without an organization context, through a definer function (P1-T09, Q31)
			sql<string | null>`careeros_public_verified_domain(${schema.resume.userId})`
		: sql<string | null>`null`;

/** The username whose primary resume a verified custom domain opens: `null` for an unknown host. */
export async function customDomainUsername(hostname: string): Promise<string | null> {
	if (!isCustomDomainsEnabled()) return null;
	// CAREEROS: the public lookup has no organization; a definer function answers for a verified domain only (P1-T09, Q31).
	const { rows } = await db.execute<{ user_id: string }>(
		sql`select user_id from careeros_public_domain_owner(${hostname.toLowerCase()})`,
	);
	const userId = rows[0]?.user_id;
	if (!userId) return null;
	const [owner] = await db
		.select({ username: schema.user.username })
		.from(schema.user)
		.where(and(eq(schema.user.id, userId), ownerIsNotBanned()));
	return owner?.username ?? null;
}

/**
 * Traefik's HTTP provider configuration: one router per verified domain, each asking the certificate resolver for its
 * own certificate. Domains not checked for a day are checked again in the background; one failing for a week loses its
 * verification, which takes its router away.
 */
export async function traefikConfiguration(options: { service: string; entryPoint: string; certResolver: string }) {
	// CAREEROS: hostnames only, through a definer function, since the provider has no organization (P1-T09).
	const { rows } = await db.execute<{ hostname: string }>(sql`select careeros_verified_domains() as hostname`);
	const hostnames = rows.map((row) => row.hostname);

	void recheckStaleDomains().catch((error: unknown) => console.warn("Custom domain re-check failed", error));

	const routers = Object.fromEntries(
		hostnames.map((hostname) => [
			`custom-domain-${hostname}`,
			{
				rule: `Host(\`${hostname}\`)`,
				entryPoints: [options.entryPoint],
				service: options.service,
				tls: { certResolver: options.certResolver },
			},
		]),
	);
	// Traefik rejects an empty map ("routers cannot be a standalone element"), but accepts an empty document.
	return hostnames.length > 0 ? { http: { routers } } : {};
}

let rechecking = false;

/**
 * CAREEROS (P1-T09, D9 pattern): the scheduler has no organization. A definer function lists the (user, organization)
 * pairs that are due, and each is re-checked inside `withOrgContext` for its own organization. One failing domain is
 * logged and does not stop the others. DNS is queried outside the database scope.
 */
export async function recheckStaleDomains() {
	if (rechecking) return;
	rechecking = true;
	try {
		const { rows: due } = await db.execute<{ user_id: string; organization_id: string }>(
			sql`select user_id, organization_id from careeros_stale_custom_domains(${new Date(Date.now() - DAY_MS)}::timestamptz, 20)`,
		);
		for (const { user_id: userId, organization_id: organizationId } of due) {
			try {
				await recheckDomain(userId, organizationId);
			} catch (error) {
				console.error(`[custom-domain] Re-check failed for organization ${organizationId}`, error);
			}
		}
	} finally {
		rechecking = false;
	}
}

async function recheckDomain(userId: string, organizationId: string) {
	const domain = await withOrgContext(organizationId, async () => {
		const [row] = await db.select().from(schema.customDomain).where(eq(schema.customDomain.userId, userId));
		return row;
	});
	if (!domain?.verifiedAt) return;
	const valid = await dnsPointsHere(domain.hostname, domain.verificationToken);
	const now = new Date();
	const unchanged = and(
		eq(schema.customDomain.userId, domain.userId),
		eq(schema.customDomain.hostname, domain.hostname),
		eq(schema.customDomain.verificationToken, domain.verificationToken),
		domain.lastCheckedAt === null
			? sql`${schema.customDomain.lastCheckedAt} is null`
			: eq(schema.customDomain.lastCheckedAt, domain.lastCheckedAt),
	);
	await withOrgContext(organizationId, async () => {
		if (valid) {
			await db.update(schema.customDomain).set({ lastCheckedAt: now, failingSince: null }).where(unchanged);
			return;
		}
		const failingSince = domain.failingSince ?? now;
		await db
			.update(schema.customDomain)
			.set({
				lastCheckedAt: now,
				failingSince,
				...(now.getTime() - failingSince.getTime() > GRACE_MS ? { verifiedAt: null } : {}),
			})
			.where(unchanged);
	});
}
