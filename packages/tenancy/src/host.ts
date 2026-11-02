import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import { env } from "@reactive-resume/env/server";

// CAREEROS (P2-T03, phase plan D2, D4): the request host decides the organization. This file turns a request into a
// `HostContext`. Nothing here reads a header other than Host (and X-Forwarded-Host when TRUST_FORWARDED_HOST is on).

export type HostContext =
	| { kind: "platform" }
	| {
			kind: "org";
			organizationId: string;
			slug: string;
			via: "subdomain" | "custom";
			/** The normalized host name that was resolved. */
			hostname: string;
			/** The browser origin of this host (scheme from APP_URL, port as sent), for the trusted-origin check. */
			origin: string;
	  }
	// `matchesOrgPattern` is true when the host has the shape of an organization host but no organization answers to it.
	| { kind: "unknown"; matchesOrgPattern: boolean };

export type HostOrg = { organizationId: string; slug: string };

/** CAREEROS (P2-T06): what a custom-domain lookup answers for a host an organization holds that is not active. */
export const INACTIVE_ORG_HOST = { inactive: true } as const;
type CustomHostAnswer = HostOrg | typeof INACTIVE_ORG_HOST | null;

export type HostResolverConfig = {
	/** Host names of APP_URL and APP_ALIAS_URL (plus development loopback names). */
	platformHosts: ReadonlySet<string>;
	/** `ORG_HOST_PATTERN`; unset turns organization hosts off. */
	orgHostPattern?: string | undefined;
	trustForwardedHost?: boolean | undefined;
	/** Scheme used to build `origin` (the scheme of APP_URL), with the colon. */
	protocol?: "http:" | "https:" | undefined;
	/** Looks an organization up by slug. */
	lookupBySlug: (slug: string) => Promise<HostOrg | null>;
	/**
	 * Verified organization custom domains (P2-T06). Never the per-user resume custom domains. It answers the
	 * organization of an ACTIVE domain, `INACTIVE_ORG_HOST` for a host an organization holds that is not active (pending,
	 * failed, removing: it must fail closed, not fall back to the platform), or `null` for a host nobody holds.
	 */
	customDomainOrg?: ((hostname: string) => Promise<HostOrg | typeof INACTIVE_ORG_HOST | null>) | undefined;
	now?: (() => number) | undefined;
	ttlMs?: number | undefined;
	maxEntries?: number | undefined;
};

const SLUG = /^[a-z0-9-]{1,63}$/;
const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(\\.${LABEL})*$`);
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 10_000;

/**
 * Splits and normalizes a `Host` header value: lower case, port separated, one trailing dot removed, IDN as punycode
 * (through `URL`). Returns `null` for anything that is not a valid host name or IP address.
 */
export function parseHost(raw: string | null | undefined): { hostname: string; port: string } | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (value.length === 0 || value.length > 300 || /[\s/\\?#@%]/.test(value)) return null;
	let url: URL;
	try {
		url = new URL(`http://${value}`);
	} catch {
		return null;
	}
	if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
	let hostname = url.hostname.toLowerCase();
	if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		return isIP(hostname.slice(1, -1)) === 6 ? { hostname, port: url.port } : null;
	}
	if (isIP(hostname) === 4 || HOSTNAME.test(hostname)) return { hostname, port: url.port };
	return null;
}

/** The normalized host name of a `Host` header value, or `null` when it is not a valid host name. */
export function normalizeHostname(raw: string | null | undefined): string | null {
	return parseHost(raw)?.hostname ?? null;
}

export type OrgHostPattern = { prefix: string; suffix: string };

/** Parses `ORG_HOST_PATTERN`: exactly one `{slug}`, and a valid host name once a slug is put in its place. */
export function parseOrgHostPattern(pattern: string | null | undefined): OrgHostPattern | null {
	if (typeof pattern !== "string") return null;
	const value = pattern.trim().toLowerCase();
	const parts = value.split("{slug}");
	if (parts.length !== 2) return null;
	if (!HOSTNAME.test(value.replace("{slug}", "a"))) return null;
	return { prefix: parts[0] ?? "", suffix: parts[1] ?? "" };
}

/** The slug in `hostname` when it has the shape of an organization host (`[a-z0-9-]{1,63}`, no dots), else `null`. */
export function matchOrgHost(hostname: string, pattern: OrgHostPattern): string | null {
	const { prefix, suffix } = pattern;
	if (!hostname.startsWith(prefix) || !hostname.endsWith(suffix)) return null;
	if (hostname.length < prefix.length + suffix.length + 1) return null;
	const slug = hostname.slice(prefix.length, hostname.length - suffix.length);
	return SLUG.test(slug) ? slug : null;
}

type CacheEntry = { org: CustomHostAnswer; expires: number };

export type HostResolver = ((request: Request) => Promise<HostContext>) & {
	/** Drops cached lookups for a slug, a host name and an organization (after its slug or a custom domain changed). */
	bust: (target: {
		slug?: string | undefined;
		hostname?: string | undefined;
		organizationId?: string | undefined;
	}) => void;
};

/** A resolver over `config`. Positive and negative slug lookups are cached in this process for 60 s, 10,000 entries. */
export function createHostResolver(config: HostResolverConfig): HostResolver {
	const pattern = parseOrgHostPattern(config.orgHostPattern);
	const now = config.now ?? Date.now;
	const ttl = config.ttlMs ?? CACHE_TTL_MS;
	const maxEntries = config.maxEntries ?? CACHE_MAX_ENTRIES;
	const protocol = config.protocol ?? "https:";
	const cache = new Map<string, CacheEntry>();

	const cached = async (key: string, load: () => Promise<CustomHostAnswer>): Promise<CustomHostAnswer> => {
		const hit = cache.get(key);
		if (hit && hit.expires > now()) return hit.org;
		const org = await load();
		cache.delete(key);
		// The oldest entry (first inserted) makes room, so one busy host cannot flush the others.
		if (cache.size >= maxEntries) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
		cache.set(key, { org, expires: now() + ttl });
		return org;
	};

	const hostHeader = (request: Request): string | null => {
		if (config.trustForwardedHost) {
			const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0];
			if (forwarded?.trim()) return forwarded;
		}
		const header = request.headers.get("host");
		if (header) return header;
		try {
			return new URL(request.url).host;
		} catch {
			return null;
		}
	};

	const resolver = async (request: Request): Promise<HostContext> => {
		// With organization hosts off, every host is the platform: byte-for-byte the Phase 1 behaviour.
		if (!pattern && !config.customDomainOrg) return { kind: "platform" };
		const parsed = parseHost(hostHeader(request));
		if (!parsed) return { kind: "unknown", matchesOrgPattern: false };
		const { hostname, port } = parsed;
		if (config.platformHosts.has(hostname)) return { kind: "platform" };

		const origin = new URL(`${protocol}//${hostname}${port ? `:${port}` : ""}`).origin;
		const slug = pattern ? matchOrgHost(hostname, pattern) : null;
		if (slug) {
			const org = (await cached(`slug:${slug}`, () => config.lookupBySlug(slug))) as HostOrg | null;
			return org
				? { kind: "org", organizationId: org.organizationId, slug: org.slug, via: "subdomain", hostname, origin }
				: { kind: "unknown", matchesOrgPattern: true };
		}
		if (config.customDomainOrg) {
			const custom = config.customDomainOrg;
			const org = await cached(`host:${hostname}`, () => custom(hostname));
			if (org && "organizationId" in org) {
				return { kind: "org", organizationId: org.organizationId, slug: org.slug, via: "custom", hostname, origin };
			}
			// CAREEROS (P2-T06): an organization holds this host but it is not active (pending, failed, removing). It
			// answers like a pattern-shaped host nobody owns: 404, never the platform's rules.
			if (org) return { kind: "unknown", matchesOrgPattern: true };
		}
		// Without organization hosts configured, an unrecognised host is left alone, as in Phase 1.
		return pattern ? { kind: "unknown", matchesOrgPattern: false } : { kind: "platform" };
	};

	return Object.assign(resolver, {
		bust: ({
			slug,
			hostname,
			organizationId,
		}: {
			slug?: string | undefined;
			hostname?: string | undefined;
			organizationId?: string | undefined;
		}) => {
			for (const [key, entry] of cache) {
				if (
					(slug !== undefined && key === `slug:${slug}`) ||
					(hostname !== undefined && key === `host:${hostname}`) ||
					(organizationId &&
						entry.org !== null &&
						"organizationId" in entry.org &&
						entry.org.organizationId === organizationId)
				)
					cache.delete(key);
			}
		},
	});
}

/** Looks an organization up by slug through the public definer function (T01); no session or organization needed. */
export async function lookupOrgBySlug(slug: string): Promise<HostOrg | null> {
	const { rows } = await db.execute<{ organization_id: string; slug: string }>(
		sql`select organization_id, slug from careeros_public_branding_by_slug(${slug}::text)`,
	);
	const row = rows[0];
	return row ? { organizationId: row.organization_id, slug: row.slug } : null;
}

/**
 * CAREEROS (P2-T06): whether organization custom domains are switched on. They need the Cloudflare for SaaS settings;
 * without them no domain can become active, and the host lookup is not even attempted.
 */
export function orgCustomDomainsEnabled(): boolean {
	return Boolean(env.CF_SAAS_API_TOKEN && env.CF_ZONE_ID && env.CF_SAAS_CNAME_TARGET);
}

/**
 * CAREEROS (P2-T06): the organization of a custom domain, through the definer functions (no session or organization
 * needed). Only an `active` domain answers with its organization; any other status answers `INACTIVE_ORG_HOST`.
 */
export async function lookupOrgByCustomHost(hostname: string): Promise<HostOrg | typeof INACTIVE_ORG_HOST | null> {
	const { rows } = await db.execute<{ organization_id: string | null; slug: string | null; registered: boolean }>(
		sql`select o.organization_id, o.slug, careeros_org_domain_is_registered(${hostname}::text) as registered
			from (select 1) as one left join careeros_org_for_custom_host(${hostname}::text) as o on true`,
	);
	const row = rows[0];
	if (row?.organization_id && row.slug) return { organizationId: row.organization_id, slug: row.slug };
	return row?.registered ? INACTIVE_ORG_HOST : null;
}

/** The host names the platform itself answers on: APP_URL, APP_ALIAS_URL, and loopback names outside production. */
export function platformHostsFromEnv(): Set<string> {
	const hosts = new Set<string>();
	for (const url of [env.APP_URL, env.APP_ALIAS_URL]) {
		if (!url) continue;
		const hostname = normalizeHostname(new URL(url).host);
		if (hostname) hosts.add(hostname);
	}
	if (process.env.NODE_ENV !== "production") {
		hosts.add("localhost");
		hosts.add("127.0.0.1");
	}
	return hosts;
}

let defaultResolver: HostResolver | undefined;

function getDefaultResolver(): HostResolver {
	defaultResolver ??= createHostResolver({
		platformHosts: platformHostsFromEnv(),
		orgHostPattern: env.ORG_HOST_PATTERN,
		trustForwardedHost: env.TRUST_FORWARDED_HOST,
		protocol: new URL(env.APP_URL).protocol === "http:" ? "http:" : "https:",
		lookupBySlug: lookupOrgBySlug,
		// CAREEROS (P2-T06): active organization custom domains. The per-user resume domains (`custom_domain`, Traefik
		// provider) are never organization hosts. Off without the Cloudflare for SaaS settings.
		customDomainOrg: orgCustomDomainsEnabled() ? lookupOrgByCustomHost : undefined,
	});
	return defaultResolver;
}

/** Resolves the request's host from the environment's configuration. Resolve once per request. */
export function resolveHost(request: Request): Promise<HostContext> {
	return getDefaultResolver()(request);
}

/** Drops cached host lookups after an organization's slug changed (the 60 s cache would otherwise keep the old one). */
export function bustHostCache(target: {
	slug?: string | undefined;
	hostname?: string | undefined;
	organizationId?: string | undefined;
}): void {
	defaultResolver?.bust(target);
}

/** Replaces the default resolver. Tests only. */
export function setHostResolverForTesting(resolver: HostResolver | undefined): void {
	defaultResolver = resolver;
}

/**
 * The origins the request host adds to the trusted ones: its own origin when it resolves to an organization host,
 * else none. Never throws; a lookup failure trusts nothing extra.
 */
export async function hostTrustedOrigins(request: Request | undefined): Promise<string[]> {
	if (!request) return [];
	try {
		const host = await resolveHost(request);
		return host.kind === "org" ? [host.origin] : [];
	} catch {
		return [];
	}
}

const hostStore = new AsyncLocalStorage<HostContext>();

/** Runs `fn` with `host` as the current request's host, for code that was not handed the context (adapters). */
export function runWithHost<T>(host: HostContext, fn: () => T): T {
	return hostStore.run(host, fn);
}

/** The host of the request being served, when a server adapter registered it with `runWithHost`. */
export function currentHost(): HostContext | undefined {
	return hostStore.getStore();
}
