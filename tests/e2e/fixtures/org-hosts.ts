import type { E2EAccount } from "./data";
import type { APIResponse, PlaywrightWorkerArgs } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deleteE2EOrganizations } from "./careeros-org";
import { deleteE2EUser } from "./db";
import { withSeedPool } from "./seed-db";

// CareerOS (P2-T05, P2-Q01, P2-Q02): helpers for specs that reach the app on organization hosts.
//
// The server must run with ORG_HOST_PATTERN={slug}.orgs.test (the CI e2e job sets it). No e2e host on localhost
// matches it, so every other spec is unaffected. Organization hosts are reached with a Host header for API checks and
// with a Chromium host-resolver rule for the browser checks. Test-only; never use this in application code.

export type Playwright = PlaywrightWorkerArgs["playwright"];

export const ORG_HOST_PATTERN = "{slug}.orgs.test";

/** Chromium launch option that sends every `*.orgs.test` host to the local e2e server. */
export const ORG_HOST_LAUNCH_OPTIONS = { args: ["--host-resolver-rules=MAP *.orgs.test 127.0.0.1"] };

/** True when the e2e server was started with organization hosts on. */
export const orgHostsConfigured = () => process.env.ORG_HOST_PATTERN === ORG_HOST_PATTERN;

export type OrgHost = { id: string; slug: string; host: string; origin: string };

/** An organization host for a test: ids carry the run tag, so parallel runs and reruns never collide. */
export function makeOrgHost(prefix: string, label: string, tag: string, port: string): OrgHost {
	const slug = `${prefix}${label}${tag}`;
	return {
		id: `${prefix}-${label}-${tag}`,
		slug,
		host: `${slug}.orgs.test:${port}`,
		origin: `http://${slug}.orgs.test:${port}`,
	};
}

export const cookiePairs = (response: APIResponse) =>
	response
		.headersArray()
		.filter((header) => header.name.toLowerCase() === "set-cookie")
		.map((header) => header.value);

export const cookieHeader = (lines: string[]) =>
	lines
		.map((line) => line.split(";", 1)[0] ?? "")
		.filter((pair) => !pair.endsWith("="))
		.join("; ");

export type SendOptions = {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	host?: string;
	origin?: string;
	cookie?: string;
	apiKey?: string;
	data?: unknown;
	multipart?: Record<string, { name: string; mimeType: string; buffer: Buffer }>;
	headers?: Record<string, string>;
};

/** One request to an organization host (or the platform), with exactly the cookies and headers given. */
export async function send(playwright: Playwright, baseURL: string, options: SendOptions) {
	const context = await playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: {
			...(options.host ? { host: options.host } : {}),
			...(options.origin ? { origin: options.origin } : {}),
			...(options.cookie ? { cookie: options.cookie } : {}),
			...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
			...options.headers,
		},
	});
	try {
		const base = { maxRedirects: 0, failOnStatusCode: false, timeout: 20_000 } as const;
		const response = await context.fetch(options.path, {
			...base,
			method: options.method,
			...(options.multipart
				? { multipart: options.multipart }
				: options.method === "GET"
					? {}
					: { data: options.data ?? {} }),
		});
		const bytes = await response.body();
		return { response, body: bytes.toString("utf8"), bytes };
	} finally {
		await context.dispose();
	}
}

export type HostMember = {
	account: E2EAccount;
	userId: string;
	/** The cookie header of a session created ON the organization's host (host-only). */
	cookie: string;
};

export type BrandingSeed = {
	appName: string;
	/** `#rrggbb` */
	primaryColor: string;
	emailFromName: string;
	/** Fixture files under `tests/e2e/fixtures/branding/`. */
	logoFile: string;
	faviconFile: string;
};

export type HostOrgSeed = OrgHost & {
	owner: HostMember;
	member: HostMember;
	branding?: BrandingSeed | undefined;
	/** Set after the logo and favicon upload: the paths the server serves them at. */
	assets?: { logoPath: string; faviconPath: string } | undefined;
};

// Playwright runs from the repository root (playwright.config.ts lives there).
const BRANDING_DIR = join(process.cwd(), "tests", "e2e", "fixtures", "branding");
export const readBrandingFixture = (file: string) => readFileSync(join(BRANDING_DIR, file));

const PASSWORD = "Password123!";

async function platformSignUp(playwright: Playwright, baseURL: string, account: E2EAccount) {
	const platform = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
	try {
		const response = await platform.post("/api/auth/sign-up/email", {
			data: {
				name: account.name,
				email: account.email,
				password: account.password,
				username: account.username,
				displayUsername: account.username,
			},
		});
		if (!response.ok()) throw new Error(`Sign-up of ${account.username} failed with ${response.status()}`);
	} finally {
		await platform.dispose();
	}
	return withSeedPool(async (pool) => {
		const { rows } = await pool.query<{ id: string }>('select id from "user" where email = $1', [account.email]);
		return rows[0]?.id ?? "";
	});
}

/** Signs in on the organization's own host: the session cookie is host-only. */
export async function signInOnHost(playwright: Playwright, baseURL: string, org: OrgHost, account: E2EAccount) {
	const { response, body } = await send(playwright, baseURL, {
		method: "POST",
		path: "/api/auth/sign-in/email",
		host: org.host,
		origin: org.origin,
		data: { email: account.email, password: account.password },
	});
	if (!response.ok()) throw new Error(`Sign-in on ${org.host} failed with ${response.status()}: ${body.slice(0, 200)}`);
	return cookieHeader(cookiePairs(response));
}

function makeAccount(prefix: string, label: string, role: string, tag: string): E2EAccount {
	const username = `${prefix}_${label}_${role}_${tag}`;
	return { name: `${prefix} ${label} ${role}`, username, email: `${username}@example.test`, password: PASSWORD };
}

export type HostOrgs = {
	baseURL: string;
	a: HostOrgSeed;
	b: HostOrgSeed;
	dispose: () => Promise<void>;
};

/**
 * Two organizations on two hosts, each with an owner and a member. Rows are inserted through the owner role
 * (`withSeedPool`), accounts are made through the real sign-up, and sessions are real sign-ins on each host.
 *
 * With `branding`, the text fields (name, colour, sender name) are set through SQL and the logo and favicon through the
 * real upload endpoints (P2-T01), because the settings UI (P2-T07) is not what these specs prove.
 */
export async function createHostOrgs(
	playwright: Playwright,
	baseURL: string,
	options: { prefix: string; branding?: { a: BrandingSeed; b: BrandingSeed } },
): Promise<HostOrgs> {
	const port = new URL(baseURL).port || "80";
	const tag = randomUUID().slice(0, 8);
	const accounts: E2EAccount[] = [];
	const orgIds: string[] = [];
	const dispose = async () => {
		// Organizations first (their members reference the users), then the users and their personal organizations.
		await withSeedPool(async (pool) => {
			await pool.query("delete from organization where id = any($1::text[])", [orgIds]);
		});
		await deleteE2EOrganizations(accounts);
		for (const account of accounts) await deleteE2EUser(account);
	};

	const seedOrg = async (label: "a" | "b", branding: BrandingSeed | undefined): Promise<HostOrgSeed> => {
		const org = makeOrgHost(options.prefix, label, tag, port);
		orgIds.push(org.id);
		const ownerAccount = makeAccount(options.prefix, label, "owner", tag);
		const memberAccount = makeAccount(options.prefix, label, "member", tag);
		accounts.push(ownerAccount, memberAccount);
		const ownerId = await platformSignUp(playwright, baseURL, ownerAccount);
		const memberId = await platformSignUp(playwright, baseURL, memberAccount);
		await withSeedPool(async (pool) => {
			await pool.query("insert into organization (id, name, slug) values ($1, $2, $3)", [org.id, org.slug, org.slug]);
			await pool.query("insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'owner')", [
				`m-${org.id}-o`,
				org.id,
				ownerId,
			]);
			await pool.query("insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'member')", [
				`m-${org.id}-m`,
				org.id,
				memberId,
			]);
			if (branding) {
				// A trigger creates the organization's branding row with the organization; this fills it in.
				await pool.query(
					"update organization_branding set app_name = $2, primary_color = $3, email_from_name = $4 where organization_id = $1",
					[org.id, branding.appName, branding.primaryColor, branding.emailFromName],
				);
			}
		});
		const seeded: HostOrgSeed = {
			...org,
			owner: {
				account: ownerAccount,
				userId: ownerId,
				cookie: await signInOnHost(playwright, baseURL, org, ownerAccount),
			},
			member: {
				account: memberAccount,
				userId: memberId,
				cookie: await signInOnHost(playwright, baseURL, org, memberAccount),
			},
			branding,
		};
		if (branding) {
			const upload = async (kind: "logo" | "favicon", file: string) => {
				const { response, body } = await send(playwright, baseURL, {
					method: "POST",
					path: `/api/openapi/branding/${kind}`,
					host: org.host,
					origin: org.origin,
					cookie: seeded.owner.cookie,
					multipart: { file: { name: file, mimeType: "image/png", buffer: readBrandingFixture(file) } },
				});
				if (!response.ok())
					throw new Error(`Uploading ${kind} for ${org.host} failed with ${response.status()}: ${body.slice(0, 200)}`);
				return new URL((JSON.parse(body) as { url: string }).url, org.origin).pathname;
			};
			seeded.assets = {
				logoPath: await upload("logo", branding.logoFile),
				faviconPath: await upload("favicon", branding.faviconFile),
			};
		}
		return seeded;
	};

	try {
		const a = await seedOrg("a", options.branding?.a);
		const b = await seedOrg("b", options.branding?.b);
		return { baseURL, a, b, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}
