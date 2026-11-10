// CAREEROS: P2-C01. Manages the Cloudflare side of staging organization hosts and custom domains:
// the tunnel ingress, the Cloudflare for SaaS fallback origin and one proxied CNAME per organization host.
// Plain Node 24, no dependencies, global fetch. Settings come from the environment only, never from arguments.
// Usage: node infra/staging/cloudflare.mjs <command> [slug] [--apply]
//   tunnel-ingress | fallback-origin | org-dns <slug> | org-dns-remove <slug> | org-dns-sync | status
// P2-C05: `org-dns-sync` reads slugs (one per line) from stdin and creates the missing managed CNAMEs; it never deletes.
// Dry run by default: reads current state, prints the writes it would make, makes none. Tokens are never printed.
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
/** Comment on every DNS record this script creates; `org-dns-remove` deletes only records that carry it. */
export const MANAGED_COMMENT = "careeros-staging-managed";
const ORIGIN_SERVICE = "http://app:3000";
// Mirrors SLUG in packages/tenancy/src/host.ts (the rule the app uses to read an organization slug out of a host).
const SLUG = /^[a-z0-9-]{1,63}$/;
const MAX_LABEL = 63;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

/** P2-C05: the most records one `org-dns-sync` run creates (a guard against a runaway slug list). */
export const SYNC_CAP = 50;

export const COMMANDS = ["tunnel-ingress", "fallback-origin", "org-dns", "org-dns-remove", "org-dns-sync", "status"];

/** Settings each command needs; checked before any API call so a missing one fails with its name. */
const REQUIRED = {
	"tunnel-ingress": ["CF_STAGING_INFRA_TOKEN", "CF_ACCOUNT_ID", "CF_TUNNEL_ID", "STAGING_HOST"],
	"fallback-origin": [
		"CF_STAGING_INFRA_TOKEN",
		"CF_SAAS_API_TOKEN",
		"CF_ZONE_ID",
		"CF_TUNNEL_ID",
		"CF_SAAS_CNAME_TARGET",
		"ORG_HOST_PATTERN",
	],
	"org-dns": ["CF_STAGING_INFRA_TOKEN", "CF_ZONE_ID", "CF_TUNNEL_ID", "ORG_HOST_PATTERN"],
	"org-dns-remove": ["CF_STAGING_INFRA_TOKEN", "CF_ZONE_ID", "CF_TUNNEL_ID", "ORG_HOST_PATTERN"],
	"org-dns-sync": ["CF_STAGING_INFRA_TOKEN", "CF_ZONE_ID", "CF_TUNNEL_ID", "ORG_HOST_PATTERN"],
	status: [
		"CF_STAGING_INFRA_TOKEN",
		"CF_SAAS_API_TOKEN",
		"CF_ACCOUNT_ID",
		"CF_ZONE_ID",
		"CF_TUNNEL_ID",
		"STAGING_HOST",
		"ORG_HOST_PATTERN",
	],
};

class UserError extends Error {}

/** Splits `ORG_HOST_PATTERN` (exactly one `{slug}`) into its prefix and suffix, or `null` when it is malformed. */
export function parsePattern(value) {
	const parts = value.split("{slug}");
	if (parts.length !== 2) return null;
	if (!HOST.test(value.replace("{slug}", "a"))) return null;
	return { prefix: parts[0], suffix: parts[1] };
}

/** The slug when `hostname` has the shape of an organization host under `pattern`, else `null`. */
export function matchOrgHost(hostname, pattern) {
	const { prefix, suffix } = pattern;
	if (hostname.length < prefix.length + suffix.length) return null;
	if (!hostname.startsWith(prefix) || !hostname.endsWith(suffix)) return null;
	const slug = hostname.slice(prefix.length, hostname.length - suffix.length);
	return SLUG.test(slug) ? slug : null;
}

/** Builds the host for `slug`; throws a UserError for an invalid slug or a first label over 63 characters. */
export function buildOrgHost(slug, pattern) {
	if (typeof slug !== "string" || !SLUG.test(slug)) {
		throw new UserError("Invalid slug: use 1 to 63 characters from a-z, 0-9 and hyphen.");
	}
	// A DNS label cannot start or end with a hyphen (stricter than the app's SLUG rule; Q160).
	if (slug.startsWith("-") || slug.endsWith("-")) {
		throw new UserError("Invalid slug: it cannot start or end with a hyphen.");
	}
	const host = `${pattern.prefix}${slug}${pattern.suffix}`;
	if (host.split(".")[0].length > MAX_LABEL) {
		throw new UserError(`Invalid slug: the host label would be longer than ${MAX_LABEL} characters.`);
	}
	return host;
}

class CloudflareError extends Error {}

function createClient(fetchImpl) {
	return async function cf(method, path, token, body) {
		let res;
		try {
			res = await fetchImpl(`${API}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new CloudflareError(`${method} ${path}: the request failed (network error).`);
		}
		let json = null;
		try {
			json = await res.json();
		} catch {
			// Not JSON; reported below from the status only.
		}
		if (!res.ok || !json || json.success !== true) {
			const errors = Array.isArray(json?.errors) ? json.errors : [];
			const detail = errors.length
				? errors.map((e) => `${e?.code ?? "?"}: ${String(e?.message ?? "").slice(0, 200)}`).join("; ")
				: "no error details";
			throw new CloudflareError(`${method} ${path} failed (HTTP ${res.status}): ${detail}`);
		}
		return json.result;
	};
}

function ingressFor(stagingHost) {
	return [{ hostname: stagingHost, service: ORIGIN_SERVICE }, { service: ORIGIN_SERVICE }];
}

const line = (rule) => (rule.hostname ? `${rule.hostname} -> ${rule.service}` : `(catch-all) -> ${rule.service}`);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function tunnelIngress(ctx) {
	const { cf, env, say } = ctx;
	const path = `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${env.CF_TUNNEL_ID}/configurations`;
	const current = await cf("GET", path, env.CF_STAGING_INFRA_TOKEN);
	const oldConfig = current?.config ?? {};
	const oldIngress = Array.isArray(oldConfig.ingress) ? oldConfig.ingress : [];
	const newIngress = ingressFor(env.STAGING_HOST);
	say("Tunnel ingress, current:");
	for (const rule of oldIngress) say(`- ${line(rule)}`);
	if (!oldIngress.length) say("- (none)");
	say("Tunnel ingress, wanted:");
	for (const rule of newIngress) say(`+ ${line(rule)}`);
	if (sameJson(oldIngress, newIngress)) {
		say("No change needed.");
		return;
	}
	const body = { config: { ...oldConfig, ingress: newIngress } };
	await write(ctx, "PUT", path, env.CF_STAGING_INFRA_TOKEN, body);
}

/** Performs a write when `--apply` is set, otherwise only prints it. */
async function write(ctx, method, path, token, body) {
	const { cf, apply, say } = ctx;
	say(`${apply ? "APPLY" : "PLAN"}: ${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`);
	if (apply) await cf(method, path, token, body);
}

async function findCname(ctx, name) {
	const { cf, env } = ctx;
	const q = new URLSearchParams({ type: "CNAME", name, per_page: "5" });
	const list = await cf("GET", `/zones/${env.CF_ZONE_ID}/dns_records?${q}`, env.CF_STAGING_INFRA_TOKEN);
	return Array.isArray(list) ? list.find((r) => r?.name === name) : undefined;
}

/** The record body for a managed, proxied CNAME to the tunnel (shared by `org-dns` and `org-dns-sync`). */
function managedCnameBody(env, name) {
	return {
		type: "CNAME",
		name,
		content: `${env.CF_TUNNEL_ID}.cfargotunnel.com`,
		proxied: true,
		ttl: 1,
		comment: MANAGED_COMMENT,
	};
}

/** Ensures a proxied, tagged CNAME to the tunnel. Refuses to touch a record this script did not create. */
async function ensureCname(ctx, name) {
	const { env, say } = ctx;
	const wanted = managedCnameBody(env, name);
	const existing = await findCname(ctx, name);
	const base = `/zones/${env.CF_ZONE_ID}/dns_records`;
	if (!existing) {
		await write(ctx, "POST", base, env.CF_STAGING_INFRA_TOKEN, wanted);
		return;
	}
	const correct = existing.content === wanted.content && existing.proxied === true;
	if (existing.comment !== MANAGED_COMMENT) {
		if (correct) {
			say(`${name}: record exists and is correct (not tagged as managed); no change.`);
			return;
		}
		throw new UserError(
			`${name}: a record exists that this script did not create and it differs; refusing to change it.`,
		);
	}
	if (correct) {
		say(`${name}: no change needed.`);
		return;
	}
	await write(ctx, "PATCH", `${base}/${existing.id}`, env.CF_STAGING_INFRA_TOKEN, wanted);
}

async function fallbackOrigin(ctx) {
	const { cf, env, say, pattern } = ctx;
	// The same value the app hands to customers as the CNAME target, so the two cannot drift (Q162).
	const name = env.CF_SAAS_CNAME_TARGET;
	if (matchOrgHost(name, pattern)) {
		throw new UserError(`${name} matches ORG_HOST_PATTERN and would be read as an organization host; refusing.`);
	}
	await ensureCname(ctx, name);
	const path = `/zones/${env.CF_ZONE_ID}/custom_hostnames/fallback_origin`;
	let current = null;
	try {
		current = await cf("GET", path, env.CF_SAAS_API_TOKEN);
	} catch (error) {
		// No fallback origin set yet is reported as an error by Cloudflare; any other failure shows again on the write.
		say(`Fallback origin: not readable yet (${error.message}).`);
	}
	if (current?.origin === name) {
		say(`Fallback origin ${name}: already set (status ${current.status ?? "unknown"}).`);
		return;
	}
	await write(ctx, "PUT", path, env.CF_SAAS_API_TOKEN, { origin: name });
}

async function orgDns(ctx, slug) {
	const host = buildOrgHost(slug, ctx.pattern);
	await ensureCname(ctx, host);
}

/** Every CNAME name in the zone, read once (paged), so the sync can tell which hosts already have a record. */
async function listCnameNames(ctx) {
	const { cf, env } = ctx;
	const names = new Set();
	for (let page = 1; page <= 100; page++) {
		const q = new URLSearchParams({ type: "CNAME", per_page: "100", page: String(page) });
		const list = await cf("GET", `/zones/${env.CF_ZONE_ID}/dns_records?${q}`, env.CF_STAGING_INFRA_TOKEN);
		const rows = Array.isArray(list) ? list : [];
		for (const r of rows) if (typeof r?.name === "string") names.add(r.name);
		if (rows.length < 100) break;
	}
	return names;
}

/** P2-C05: creates the managed CNAME for each stdin slug that lacks one. Never changes or deletes a record. */
async function orgDnsSync(ctx, slugs) {
	const { env, say } = ctx;
	const seen = new Set(slugs.map((s) => s.trim()).filter((s) => s.length > 0));
	const existing = await listCnameNames(ctx);
	let created = 0;
	let skipped = 0;
	let capped = false;
	for (const slug of seen) {
		let host;
		try {
			host = buildOrgHost(slug, ctx.pattern);
		} catch (error) {
			// One bad slug never stops the run.
			say(`Notice: skipped an invalid slug (${JSON.stringify(slug.slice(0, 80))}): ${error.message}`);
			skipped++;
			continue;
		}
		if (existing.has(host)) {
			skipped++;
			continue;
		}
		if (created >= SYNC_CAP) {
			capped = true;
			skipped++;
			continue;
		}
		await write(
			ctx,
			"POST",
			`/zones/${env.CF_ZONE_ID}/dns_records`,
			env.CF_STAGING_INFRA_TOKEN,
			managedCnameBody(env, host),
		);
		existing.add(host);
		created++;
	}
	if (capped) say(`Notice: the cap of ${SYNC_CAP} creations per run was reached; the rest wait for the next run.`);
	say(`Summary: ${seen.size} slugs seen, ${created} ${ctx.apply ? "created" : "to create"}, ${skipped} skipped.`);
}

async function orgDnsRemove(ctx, slug) {
	const { env, say } = ctx;
	const host = buildOrgHost(slug, ctx.pattern);
	if (!matchOrgHost(host, ctx.pattern)) throw new UserError(`${host} does not match ORG_HOST_PATTERN; refusing.`);
	const existing = await findCname(ctx, host);
	if (!existing) {
		say(`${host}: no record; nothing to remove.`);
		return;
	}
	if (existing.name !== host || !matchOrgHost(existing.name, ctx.pattern)) {
		throw new UserError(`${host}: the record name is outside ORG_HOST_PATTERN; refusing.`);
	}
	if (existing.comment !== MANAGED_COMMENT) {
		throw new UserError(`${host}: the record is not tagged "${MANAGED_COMMENT}"; refusing to delete it.`);
	}
	await write(ctx, "DELETE", `/zones/${env.CF_ZONE_ID}/dns_records/${existing.id}`, env.CF_STAGING_INFRA_TOKEN);
}

async function status(ctx) {
	const { cf, env, say, pattern } = ctx;
	const conf = await cf(
		"GET",
		`/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${env.CF_TUNNEL_ID}/configurations`,
		env.CF_STAGING_INFRA_TOKEN,
	);
	const ingress = Array.isArray(conf?.config?.ingress) ? conf.config.ingress : [];
	say("Tunnel ingress:");
	for (const rule of ingress) say(`- ${line(rule)}`);
	if (!ingress.length) say("- (none)");
	try {
		const fb = await cf("GET", `/zones/${env.CF_ZONE_ID}/custom_hostnames/fallback_origin`, env.CF_SAAS_API_TOKEN);
		say(`Fallback origin: ${fb?.origin ?? "(none)"} (status ${fb?.status ?? "unknown"})`);
	} catch (error) {
		say(`Fallback origin: not available (${error.message})`);
	}
	const q = new URLSearchParams({ type: "CNAME", "comment.exact": MANAGED_COMMENT, per_page: "100" });
	const records = await cf("GET", `/zones/${env.CF_ZONE_ID}/dns_records?${q}`, env.CF_STAGING_INFRA_TOKEN);
	const managed = (Array.isArray(records) ? records : []).filter(
		(r) => r?.comment === MANAGED_COMMENT && matchOrgHost(String(r.name), pattern),
	);
	say("Managed organization records:");
	for (const r of managed) say(`- ${r.name} -> ${r.content} (proxied: ${r.proxied === true})`);
	if (!managed.length) say("- (none)");
}

async function readStdin(io) {
	if (io.stdin !== undefined) return io.stdin;
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	return text;
}

/**
 * Runs the CLI. `io` is for tests: { fetch, stdin (text), stdout(text), stderr(text) }. Returns the exit code.
 */
export async function main(argv, env, io = {}) {
	const fetchImpl = io.fetch ?? globalThis.fetch;
	const secrets = [env.CF_STAGING_INFRA_TOKEN, env.CF_SAAS_API_TOKEN].filter(
		(v) => typeof v === "string" && v.length > 0,
	);
	const scrub = (text) => secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), String(text));
	const stdout = io.stdout ?? ((t) => process.stdout.write(t));
	const stderr = io.stderr ?? ((t) => process.stderr.write(t));
	const say = (text) => stdout(`${scrub(text)}\n`);
	const fail = (text) => stderr(`${scrub(text)}\n`);

	const args = argv.filter((a) => a !== "--apply");
	const apply = argv.includes("--apply");
	const [command, slug, ...rest] = args;
	if (!COMMANDS.includes(command) || rest.length > 0) {
		fail(`Usage: cloudflare.mjs <${COMMANDS.join("|")}> [slug] [--apply]`);
		return 2;
	}
	const needsSlug = command === "org-dns" || command === "org-dns-remove";
	if (needsSlug !== (slug !== undefined)) {
		fail(needsSlug ? `${command} needs a slug.` : `${command} takes no slug.`);
		return 2;
	}
	const missing = REQUIRED[command].filter((name) => !env[name]);
	if (missing.length) {
		for (const name of missing) fail(`Missing setting: ${name} is not set.`);
		return 1;
	}
	for (const name of ["CF_ACCOUNT_ID", "CF_ZONE_ID", "CF_TUNNEL_ID"]) {
		if (env[name] && !ID.test(env[name])) {
			fail(`Invalid setting: ${name} has an unexpected format.`);
			return 1;
		}
	}
	const pattern = env.ORG_HOST_PATTERN ? parsePattern(env.ORG_HOST_PATTERN) : null;
	if (REQUIRED[command].includes("ORG_HOST_PATTERN") && !pattern) {
		fail("Invalid setting: ORG_HOST_PATTERN must contain exactly one {slug} and form a valid host name.");
		return 1;
	}
	if (env.CF_SAAS_CNAME_TARGET && !HOST.test(env.CF_SAAS_CNAME_TARGET)) {
		fail("Invalid setting: CF_SAAS_CNAME_TARGET is not a valid host name.");
		return 1;
	}
	if (env.STAGING_HOST && !HOST.test(env.STAGING_HOST)) {
		fail("Invalid setting: STAGING_HOST is not a valid host name.");
		return 1;
	}

	const ctx = { cf: createClient(fetchImpl), env, apply, say, pattern };
	say(
		apply
			? `Mode: apply (${command})`
			: `Mode: dry run (${command}); nothing is changed. Add --apply to perform the plan.`,
	);
	try {
		if (command === "tunnel-ingress") await tunnelIngress(ctx);
		else if (command === "fallback-origin") await fallbackOrigin(ctx);
		else if (command === "org-dns") await orgDns(ctx, slug);
		else if (command === "org-dns-remove") await orgDnsRemove(ctx, slug);
		else if (command === "org-dns-sync") await orgDnsSync(ctx, (await readStdin(io)).split("\n"));
		else await status(ctx);
	} catch (error) {
		if (error instanceof UserError || error instanceof CloudflareError) {
			fail(`Error: ${error.message}`);
			return 1;
		}
		fail("Error: unexpected failure.");
		return 1;
	}
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await main(process.argv.slice(2), process.env);
}
