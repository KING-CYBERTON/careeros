import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "@careeros/testing";
import { Pool } from "pg";

// P3-T02: seats and suspension on the paths that add a member or change an organization through Better Auth, with the
// real configuration on a database of its own (every migration applied), as the `careeros_app` role. Skipped only when
// the CAREEROS_TEST_* variables are absent; CI sets them.
const configured = Boolean(process.env.CAREEROS_TEST_DATABASE_URL && process.env.CAREEROS_TEST_APP_DATABASE_URL);

vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));

const PASSWORD = "correct-horse-battery";
const PLATFORM = "localhost:3000";

type Person = { userId: string; email: string; cookie: string };

describe.skipIf(!configured)("seat limit and suspension on the organization endpoints", () => {
	const run = randomUUID().slice(0, 8);
	const hostOf = (slug: string) => `${slug}.orgs.test`;
	let database: IsolatedTestDatabase;
	let owner: Pool;
	let app: Pool;
	let restorePool: (() => void) | undefined;
	let auth: typeof import("./config").auth;

	const request = (host: string, path: string, body: unknown, cookie?: string) =>
		auth.handler(
			new Request(`http://${host}/api/auth${path}`, {
				method: "POST",
				headers: {
					host,
					"content-type": "application/json",
					origin: `http://${host}`,
					...(cookie ? { cookie } : {}),
				},
				body: JSON.stringify(body),
			}),
		);
	const post = (person: Person, path: string, body: unknown) => request(PLATFORM, path, body, person.cookie);

	const signUp = async (label: string): Promise<Person> => {
		const suffix = randomUUID().slice(0, 8);
		const email = `${label}-${suffix}@example.test`;
		const response = await request(PLATFORM, "/sign-up/email", {
			name: label,
			email,
			password: PASSWORD,
			username: `${label}-${suffix}`,
		});
		expect(response.status).toBe(200);
		const { user } = (await response.json()) as { user: { id: string } };
		await owner.query(`UPDATE "user" SET email_verified = true WHERE id = $1`, [user.id]);
		const cookie = response.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		return { userId: user.id, email, cookie };
	};

	const createOrganization = async (founder: Person, plan: string) => {
		const slug = `enf-${randomUUID().slice(0, 8)}`;
		const response = await post(founder, "/organization/create", { name: slug, slug });
		expect(response.status).toBe(200);
		const { id } = (await response.json()) as { id: string };
		await setPlan(id, plan);
		return id;
	};
	const setPlan = (organizationId: string, plan: string | null, status: string | null = null) =>
		owner.query(`SELECT careeros_set_org_plan($1, $2, $3, NULL, 'test fixture')`, [organizationId, plan, status]);

	const invite = (founder: Person, organizationId: string, email: string) =>
		post(founder, "/organization/invite-member", { email, role: "member", organizationId });
	const accept = (person: Person, invitationId: string) =>
		post(person, "/organization/accept-invitation", { invitationId });
	const code = async (response: Response) => ((await response.json()) as { code?: string }).code;
	const seatsUsed = async (organizationId: string) =>
		Number(
			(
				await owner.query<{ n: string }>(
					`SELECT (SELECT count(*) FROM member WHERE organization_id = $1)
					      + (SELECT count(*) FROM invitation WHERE organization_id = $1 AND status = 'pending' AND expires_at > now()) AS n`,
					[organizationId],
				)
			).rows[0]?.n,
		);
	const invitationId = async (organizationId: string, email: string) =>
		(
			await owner.query<{ id: string }>(
				`SELECT id FROM invitation WHERE organization_id = $1 AND email = $2 AND status = 'pending'`,
				[organizationId, email],
			)
		).rows[0]?.id as string;
	const memberId = async (organizationId: string, userId: string) =>
		(
			await owner.query<{ id: string }>(`SELECT id FROM member WHERE organization_id = $1 AND user_id = $2`, [
				organizationId,
				userId,
			])
		).rows[0]?.id as string;
	const addRawMember = async (organizationId: string, person: Person) => {
		const id = `raw-${randomUUID()}`;
		await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
			id,
			organizationId,
			person.userId,
		]);
		return id;
	};

	beforeAll(async () => {
		database = await createIsolatedTestDatabase("authenf_t02");
		owner = new Pool({ connectionString: database.ownerUrl });
		app = new Pool({ connectionString: database.appUrl });
		// The configuration reads the environment when it is imported.
		process.env.DATABASE_URL = database.appUrl;
		process.env.ORG_HOST_PATTERN = "{slug}.orgs.test";
		process.env.APP_URL = `http://${PLATFORM}`;
		vi.resetModules();
		const client = await import("@reactive-resume/db/client");
		restorePool = client.bindGlobalPoolForTesting(app);
		// The test fixture sets the Starter seat limit low, as the spec's end-to-end case does.
		await owner.query(`UPDATE plan SET seat_limit = 3 WHERE id = 'starter'`);
		({ auth } = await import("./config"));
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		restorePool?.();
		await app?.end();
		await owner?.end();
		await database?.drop();
	});

	describe("seats", () => {
		it("counts pending invitations, refuses past the limit, and frees a seat when an invitation is cancelled", async () => {
			const founder = await signUp("founder");
			const org = await createOrganization(founder, "starter");
			expect((await invite(founder, org, `a-${run}@example.test`)).status).toBe(200);
			expect((await invite(founder, org, `b-${run}@example.test`)).status).toBe(200);
			expect(await seatsUsed(org)).toBe(3);

			const refused = await invite(founder, org, `c-${run}@example.test`);
			expect(refused.status).toBe(403);
			expect(await code(refused)).toBe("SEAT_LIMIT_REACHED");
			expect(await seatsUsed(org)).toBe(3);

			const cancel = await post(founder, "/organization/cancel-invitation", {
				invitationId: await invitationId(org, `b-${run}@example.test`),
			});
			expect(cancel.status).toBe(200);
			expect((await invite(founder, org, `c-${run}@example.test`)).status).toBe(200);
		});

		it("frees a seat the moment a member is removed", async () => {
			const founder = await signUp("remover");
			const guest = await signUp("removed");
			const org = await createOrganization(founder, "starter");
			expect((await invite(founder, org, guest.email)).status).toBe(200);
			expect((await accept(guest, await invitationId(org, guest.email))).status).toBe(200);
			expect((await invite(founder, org, `x-${run}@example.test`)).status).toBe(200);
			expect(await code(await invite(founder, org, `y-${run}@example.test`))).toBe("SEAT_LIMIT_REACHED");

			const removal = await post(founder, "/organization/remove-member", {
				memberIdOrEmail: await memberId(org, guest.userId),
				organizationId: org,
			});
			expect(removal.status).toBe(200);
			expect((await invite(founder, org, `y-${run}@example.test`)).status).toBe(200);
		});

		it("refuses to accept when seats filled after the invitation went out (the accept race)", async () => {
			const founder = await signUp("racer");
			const first = await signUp("first");
			const second = await signUp("second");
			const intruder = await signUp("intruder");
			const org = await createOrganization(founder, "starter");
			expect((await invite(founder, org, first.email)).status).toBe(200);
			expect((await invite(founder, org, second.email)).status).toBe(200);
			// Another route fills the last seat behind the invitations' backs (limit 3: owner + 2 invitations).
			const raw = await addRawMember(org, intruder);
			expect(await seatsUsed(org)).toBe(4);

			const refused = await accept(first, await invitationId(org, first.email));
			expect(refused.status).toBe(403);
			expect(await code(refused)).toBe("SEAT_LIMIT_REACHED");
			// The invitation is still pending and the user is still outside.
			expect(await invitationId(org, first.email)).toBeTruthy();
			expect(await memberId(org, first.userId)).toBeUndefined();

			await owner.query(`DELETE FROM member WHERE id = $1`, [raw]);
			expect((await accept(first, await invitationId(org, first.email))).status).toBe(200);
			expect(await seatsUsed(org)).toBe(3);
		});

		it("refuses the server-side add-member path at the limit", async () => {
			const founder = await signUp("adder");
			const extra = await signUp("extra");
			const org = await createOrganization(founder, "starter");
			await addRawMember(org, await signUp("fill1"));
			await addRawMember(org, await signUp("fill2"));
			await expect(
				auth.api.addMember({ body: { userId: extra.userId, role: "member", organizationId: org } }),
			).rejects.toMatchObject({ body: { code: "SEAT_LIMIT_REACHED" } });
		});

		it("treats a null seat limit as unlimited", async () => {
			const founder = await signUp("big");
			const org = await createOrganization(founder, "pro");
			for (let index = 0; index < 6; index++)
				expect((await invite(founder, org, `big-${index}-${run}@example.test`)).status).toBe(200);
		});

		it("uses the paid seats of a live subscription as the limit (Q194)", async () => {
			const founder = await signUp("paid");
			const org = await createOrganization(founder, "starter");
			await owner.query(
				`SELECT careeros_set_subscription($1, '{"provider":"manual","status":"active","seats":2}'::jsonb, NULL, 'test')`,
				[org],
			);
			expect((await invite(founder, org, `p1-${run}@example.test`)).status).toBe(200);
			expect(await code(await invite(founder, org, `p2-${run}@example.test`))).toBe("SEAT_LIMIT_REACHED");
		});

		it("keeps a personal workspace to its one seat", async () => {
			const founder = await signUp("solo");
			const { rows } = await owner.query<{ organization_id: string }>(
				`SELECT organization_id FROM member WHERE user_id = $1`,
				[founder.userId],
			);
			const personal = rows[0]?.organization_id as string;
			const refused = await invite(founder, personal, `solo-${run}@example.test`);
			expect(refused.status).toBe(403);
			expect(await code(refused)).toBe("SEAT_LIMIT_REACHED");
		});
	});

	describe("a suspended organization", () => {
		it("cannot invite, accept, add a member or change a role, and works again when reactivated", async () => {
			const founder = await signUp("sus");
			const guest = await signUp("suspguest");
			const waiting = await signUp("waiting");
			const org = await createOrganization(founder, "pro");
			expect((await invite(founder, org, guest.email)).status).toBe(200);
			expect((await accept(guest, await invitationId(org, guest.email))).status).toBe(200);
			expect((await invite(founder, org, waiting.email)).status).toBe(200);
			await setPlan(org, null, "suspended");

			const refusedInvite = await invite(founder, org, `late-${run}@example.test`);
			expect(refusedInvite.status).toBe(403);
			expect(await code(refusedInvite)).toBe("ORG_SUSPENDED");

			const refusedAccept = await accept(waiting, await invitationId(org, waiting.email));
			expect(await code(refusedAccept)).toBe("ORG_SUSPENDED");

			const refusedRole = await post(founder, "/organization/update-member-role", {
				memberId: await memberId(org, guest.userId),
				role: "admin",
				organizationId: org,
			});
			expect(refusedRole.status).toBe(403);
			expect(await code(refusedRole)).toBe("ORG_SUSPENDED");

			await expect(
				auth.api.addMember({ body: { userId: waiting.userId, role: "member", organizationId: org } }),
			).rejects.toMatchObject({ body: { code: "ORG_SUSPENDED" } });

			// Signing out is not blocked.
			expect((await post(guest, "/sign-out", {})).status).toBe(200);

			await setPlan(org, null, "active");
			expect((await invite(founder, org, `late-${run}@example.test`)).status).toBe(200);
		});
	});

	describe("open sign-up on an organization host", () => {
		const signUpOn = (host: string, label: string) => {
			const suffix = randomUUID().slice(0, 8);
			return {
				email: `${label}-${suffix}@example.test`,
				run: (email: string) =>
					request(host, "/sign-up/email", { name: label, email, password: PASSWORD, username: `${label}-${suffix}` }),
			};
		};
		const open = async (plan: string) => {
			const founder = await signUp("host-founder");
			const org = await createOrganization(founder, plan);
			const { rows } = await owner.query<{ slug: string }>(`SELECT slug FROM organization WHERE id = $1`, [org]);
			await owner.query(`UPDATE organization_settings SET open_signup = true WHERE organization_id = $1`, [org]);
			return { org, slug: rows[0]?.slug as string };
		};
		const userExists = async (email: string) =>
			(await owner.query(`SELECT 1 FROM "user" WHERE email = $1`, [email])).rowCount === 1;

		it("joins while seats are free and is refused when the organization is full, creating no account", async () => {
			const { org, slug } = await open("starter");
			// Starter limit 3: the founder holds one seat, so two sign-ups fit.
			for (const label of ["join1", "join2"]) {
				const attempt = signUpOn(hostOf(slug), label);
				expect((await attempt.run(attempt.email)).status).toBe(200);
			}
			expect(await seatsUsed(org)).toBe(3);

			const full = signUpOn(hostOf(slug), "join3");
			const response = await full.run(full.email);
			expect(response.status).toBe(403);
			expect(await code(response)).toBe("SEAT_LIMIT_REACHED");
			expect(await userExists(full.email)).toBe(false);
			expect(await seatsUsed(org)).toBe(3);
		});

		it("is refused while the organization is suspended", async () => {
			const { org, slug } = await open("pro");
			await setPlan(org, null, "suspended");
			const attempt = signUpOn(hostOf(slug), "suspjoin");
			const response = await attempt.run(attempt.email);
			expect(response.status).toBe(403);
			expect(await code(response)).toBe("ORG_SUSPENDED");
			expect(await userExists(attempt.email)).toBe(false);
		});
	});

	// P3-T02 review 1: the early check in the hooks is check-then-insert, so requests that arrive together can all pass
	// it. The database trigger `careeros_enforce_seat_limit` serializes them per organization.
	describe("concurrent requests (the database trigger)", () => {
		const CONCURRENCY = 8;
		const SETTING = "app.current_org_id";

		const insertUsers = async (count: number) => {
			const ids = Array.from({ length: count }, () => `cc-${randomUUID()}`);
			for (const id of ids)
				await owner.query(
					`INSERT INTO "user" (id, name, email, username, display_username) VALUES ($1, $1, $1 || '@example.test', $1, $1)`,
					[id],
				);
			return ids;
		};
		/** Runs `sql` as the application role inside the organization's scope, in its own transaction. */
		const asApp = async (organizationId: string, sql: string, values: unknown[]) => {
			const client = await app.connect();
			try {
				await client.query("BEGIN");
				await client.query(`SELECT set_config('${SETTING}', $1, true)`, [organizationId]);
				await client.query(sql, values);
				await client.query("COMMIT");
				return "ok" as const;
			} catch (error) {
				await client.query("ROLLBACK").catch(() => undefined);
				return (error as { code?: string }).code ?? "error";
			} finally {
				client.release();
			}
		};
		const joinAsMember = (organizationId: string, userId: string) =>
			asApp(organizationId, `INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
				`m-${randomUUID()}`,
				organizationId,
				userId,
			]);
		const inviteRaw = (organizationId: string, inviterId: string) =>
			asApp(
				organizationId,
				`INSERT INTO invitation (id, organization_id, email, role, status, expires_at, inviter_id)
				 VALUES ($1, $2, $3, 'member', 'pending', now() + interval '1 day', $4)`,
				[`i-${randomUUID()}`, organizationId, `raw-${randomUUID()}@example.test`, inviterId],
			);

		it("lets exactly one of several simultaneous invitations take the last seat", async () => {
			const founder = await signUp("cinviter");
			const org = await createOrganization(founder, "starter");
			// Limit 3: the founder and one invitation use two, so one seat is left.
			expect((await invite(founder, org, `held-${run}@example.test`)).status).toBe(200);

			const responses = await Promise.all(
				Array.from({ length: CONCURRENCY }, (_, index) => invite(founder, org, `race-${index}-${run}@example.test`)),
			);
			const statuses = responses.map((response) => response.status);
			expect(statuses.filter((status) => status === 200)).toHaveLength(1);
			for (const response of responses.filter((value) => value.status !== 200)) {
				expect(response.status).toBe(403);
				expect(await code(response)).toBe("SEAT_LIMIT_REACHED");
			}
			expect(await seatsUsed(org)).toBe(3);
		});

		it("lets exactly one of several simultaneous member inserts take the last seat", async () => {
			const founder = await signUp("cjoiner");
			const org = await createOrganization(founder, "starter");
			expect((await invite(founder, org, `held2-${run}@example.test`)).status).toBe(200);
			const users = await insertUsers(CONCURRENCY);

			const results = await Promise.all(users.map((userId) => joinAsMember(org, userId)));
			expect(results.filter((result) => result === "ok")).toHaveLength(1);
			expect(results.filter((result) => result === "CS001")).toHaveLength(CONCURRENCY - 1);
			expect(await seatsUsed(org)).toBe(3);
		});

		it("lets exactly one of a mix of simultaneous members and invitations take the last seat", async () => {
			const founder = await signUp("cmixed");
			const org = await createOrganization(founder, "starter");
			expect((await invite(founder, org, `held3-${run}@example.test`)).status).toBe(200);
			const users = await insertUsers(CONCURRENCY / 2);

			const results = await Promise.all([
				...users.map((userId) => joinAsMember(org, userId)),
				...users.map(() => inviteRaw(org, founder.userId)),
			]);
			expect(results.filter((result) => result === "ok")).toHaveLength(1);
			expect(await seatsUsed(org)).toBe(3);
		});

		it("keeps accepting an invitation a swap, even when several are accepted at once", async () => {
			const founder = await signUp("cacceptor");
			const first = await signUp("cfirst");
			const second = await signUp("csecond");
			const org = await createOrganization(founder, "starter");
			expect((await invite(founder, org, first.email)).status).toBe(200);
			expect((await invite(founder, org, second.email)).status).toBe(200);
			expect(await seatsUsed(org)).toBe(3);

			const [a, b] = await Promise.all([
				accept(first, await invitationId(org, first.email)),
				accept(second, await invitationId(org, second.email)),
			]);
			expect(a.status).toBe(200);
			expect(b.status).toBe(200);
			expect(await seatsUsed(org)).toBe(3);
		});

		it("does not limit the owner role, which migrations and platform functions use", async () => {
			const founder = await signUp("cowner");
			const org = await createOrganization(founder, "personal");
			const [extra] = await insertUsers(1);
			await owner.query(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [
				`m-${randomUUID()}`,
				org,
				extra,
			]);
			expect(await seatsUsed(org)).toBe(2);
		});
	});
});
