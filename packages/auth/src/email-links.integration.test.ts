import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// P2-T04: the real Better Auth configuration sends branded emails whose links stay on the host the flow started on,
// and only when that host is a verified organization host or the platform host. The database has every migration
// applied and is used as the `careeros_app` role. Skipped only when the CAREEROS_TEST_* variables are absent.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

type SentEmail = {
	to: string;
	subject: string;
	fromName?: string;
	replyTo?: string;
	react: { props: { url: string; brand: { appName: string; primaryColor?: string; primaryForeground?: string } } };
};
const sent = vi.hoisted(() => [] as SentEmail[]);
vi.mock("@reactive-resume/email/transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("@reactive-resume/email/transport")>()),
	sendEmail: vi.fn(async (options: SentEmail) => {
		sent.push(options);
	}),
}));

const PLATFORM = "localhost:3000";

describe.skipIf(!configured)("branded emails and their links", () => {
	const run = randomUUID().slice(0, 8);
	const orgA = { id: `mail-a-${run}`, slug: `mail-a-${run}` };
	const orgB = { id: `mail-b-${run}`, slug: `mail-b-${run}` };
	const hostOf = (slug: string) => `${slug}.orgs.test`;
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let auth: typeof import("./config").auth;

	const post = (host: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
		auth.handler(
			new Request(`http://${host}/api/auth${path}`, {
				method: "POST",
				headers: { host, "content-type": "application/json", origin: `http://${host}`, ...headers },
				body: JSON.stringify(body),
			}),
		);

	const makeUser = async (label: string, orgIds: string[]) => {
		const suffix = randomUUID().slice(0, 8);
		const id = `${label}-${suffix}`;
		const email = `${id}@example.test`;
		await owner.query(
			`INSERT INTO "user" (id, name, email, username, display_username, email_verified) VALUES ($1, $1, $2, $1, $1, true)`,
			[id, email],
		);
		for (const org of orgIds)
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
				`${id}-${org}`,
				org,
				id,
			]);
		return { id, email };
	};

	const requestReset = async (host: string, email: string, headers: Record<string, string> = {}) => {
		sent.length = 0;
		const response = await post(
			host,
			"/request-password-reset",
			{ email, redirectTo: `http://${host}/auth/reset-password` },
			headers,
		);
		expect(response.status).toBe(200);
		// Better Auth sends in the background on some runtimes; give it a moment.
		for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sent).toHaveLength(1);
		const [mail] = sent;
		if (!mail) throw new Error("No email was sent.");
		return mail;
	};

	const tokenIn = (url: string) => new URL(url).pathname.split("/").pop() ?? "";

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("mail_t04");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = `http://${PLATFORM}`;
		delete process.env.TRUST_FORWARDED_HOST;
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		for (const org of [orgA, orgB])
			await owner.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $1, $2)`, [org.id, org.slug]);
		await owner.query(
			`UPDATE organization_branding SET app_name = 'Acme Careers', primary_color = '#112233',
			   email_from_name = 'Acme Team', email_reply_to = 'help@acme.example' WHERE organization_id = $1`,
			[orgA.id],
		);
		await owner.query(`UPDATE organization_branding SET app_name = 'Beta Jobs' WHERE organization_id = $1`, [orgB.id]);
		({ auth } = await import("./config"));
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	it("brands a reset requested on org A's host as A, links to that host and keeps the token", async () => {
		// The user belongs to both organizations: the host decides, not the memberships.
		const { email } = await makeUser("both", [orgA.id, orgB.id]);
		const mail = await requestReset(hostOf(orgA.slug), email);
		const { url, brand } = mail.react.props;
		expect(new URL(url).origin).toBe(`http://${hostOf(orgA.slug)}`);
		expect(new URL(url).pathname).toMatch(/^\/api\/auth\/reset-password\//);
		expect(brand).toMatchObject({ appName: "Acme Careers", primaryColor: "#112233", primaryForeground: "#ffffff" });
		expect(mail.subject).toBe("Reset your Acme Careers password");
		expect(mail.fromName).toBe("Acme Team");
		expect(mail.replyTo).toBe("help@acme.example");
		const { rows } = await owner.query(`SELECT 1 FROM verification WHERE identifier = $1`, [
			`reset-password:${tokenIn(url)}`,
		]);
		expect(rows).toHaveLength(1);
	});

	it("brands the same user's reset on org B's host as B", async () => {
		const { email } = await makeUser("both2", [orgA.id, orgB.id]);
		const mail = await requestReset(hostOf(orgB.slug), email);
		expect(mail.react.props.brand.appName).toBe("Beta Jobs");
		expect(new URL(mail.react.props.url).origin).toBe(`http://${hostOf(orgB.slug)}`);
		expect(mail.replyTo).toBeUndefined();
		expect(mail.fromName).toBe("Beta Jobs");
	});

	it("sends the platform default and an APP_URL link on the platform host", async () => {
		const { email } = await makeUser("plain", [orgA.id]);
		const mail = await requestReset(PLATFORM, email);
		expect(new URL(mail.react.props.url).origin).toBe(`http://${PLATFORM}`);
		expect(mail.react.props.brand.appName).toBe("CareerOS");
		expect(mail.fromName).toBeUndefined();
		expect(mail.replyTo).toBeUndefined();
		expect(mail.subject).toBe("Reset your CareerOS password");
	});

	it("links a forged X-Forwarded-Host to APP_URL when TRUST_FORWARDED_HOST is off", async () => {
		const { email } = await makeUser("forged", [orgA.id]);
		const mail = await requestReset(PLATFORM, email, { "x-forwarded-host": hostOf(orgA.slug) });
		expect(new URL(mail.react.props.url).origin).toBe(`http://${PLATFORM}`);
		expect(mail.react.props.brand.appName).toBe("CareerOS");
	});

	it("never links to a host that is not the platform or a verified organization host", async () => {
		const { email } = await makeUser("evil", [orgA.id]);
		for (const host of ["evil.example", `ghost-${run}.orgs.test`]) {
			sent.length = 0;
			await post(host, "/request-password-reset", { email, redirectTo: `http://${host}/x` }, {});
			await new Promise((resolve) => setTimeout(resolve, 150));
			for (const mail of sent) expect(new URL(mail.react.props.url).origin).toBe(`http://${PLATFORM}`);
		}
	});

	it("brands an invitation with the inviting organization and links to that organization's host", async () => {
		const { organizationOptions } = await import("./organization");
		sent.length = 0;
		await organizationOptions.sendInvitationEmail({
			id: "inv-1",
			email: "new@example.test",
			role: "member",
			organization: { id: orgA.id, name: "Acme Org", slug: orgA.slug },
			inviter: { user: { name: "Ines" } },
		} as never);
		expect(sent).toHaveLength(1);
		const [mail] = sent;
		if (!mail) throw new Error("No email was sent.");
		expect(mail.react.props.url).toBe(`http://${hostOf(orgA.slug)}:3000/auth/accept-invitation/inv-1`);
		expect(mail.react.props.brand.appName).toBe("Acme Careers");
		expect(mail.subject).toBe("Join Acme Org on Acme Careers");
		expect(mail.fromName).toBe("Acme Team");
		expect(mail.replyTo).toBe("help@acme.example");
	});
});
