import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as schema from "@reactive-resume/db/schema";

const mocks = vi.hoisted(() => {
	const updateWhere = vi.fn((_where?: unknown) => Promise.resolve([]));
	const updateSet = vi.fn((_values: Record<string, unknown>) => ({
		where: updateWhere,
	}));
	const update = vi.fn((_table: unknown) => ({
		set: updateSet,
	}));
	const deleteWhere = vi.fn((_where?: unknown) => Promise.resolve([]));
	const deleteFn = vi.fn((_table: unknown) => ({
		where: deleteWhere,
	}));
	const select = vi.fn(() => ({
		from: (table: unknown) => {
			const rows =
				table === schema.user
					? [{ id: "fixture-owner" }]
					: table === schema.application
						? [{ id: "guest-application", status: "saved", laneId: null, activity: [] }]
						: [];
			return {
				where: () =>
					Object.assign(Promise.resolve(rows), {
						for: () => Promise.resolve(rows),
						// CAREEROS (P1-T04): the target account's oldest membership
						orderBy: () => ({ limit: () => Promise.resolve([{ organizationId: "org-user-456" }]) }),
					}),
			};
		},
	}));
	const insert = vi.fn(() => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve() }) }));
	// CAREEROS (P1-T09): the guest's erasure prefixes come back from a definer function as `rows`
	const execute = vi.fn((_query?: unknown) =>
		Promise.resolve({ rows: [] as { storageKey: string }[] } as { rows: { storageKey: string }[] } | undefined),
	);
	const tx = { select, insert, update, delete: deleteFn, execute };
	const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx));
	return { update, updateSet, updateWhere, delete: deleteFn, deleteWhere, execute, transaction, tx };
});

vi.mock("better-auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("better-auth")>()),
	betterAuth: () => ({ $context: Promise.resolve({}), api: {} }),
}));
vi.mock("@reactive-resume/db/client", () => ({
	db: { transaction: mocks.transaction },
}));
vi.mock("@reactive-resume/email/transport", () => ({ sendEmail: vi.fn() }));
vi.mock("@reactive-resume/env/server", () => ({
	env: { APP_URL: "https://resume.example", AUTH_SECRET: "link-test" },
}));

const { linkAnonymousAccount, setAccountLinkHook } = await import("./config");

beforeEach(() => {
	mocks.update.mockClear();
	mocks.execute.mockClear();
	mocks.updateSet.mockClear();
	mocks.updateWhere.mockClear();
	mocks.delete.mockClear();
	mocks.deleteWhere.mockClear();
	mocks.transaction.mockClear();
	setAccountLinkHook();
});

describe("linkAnonymousAccount", () => {
	it("copies before commit and cleans up only after commit", async () => {
		const events: string[] = [];
		setAccountLinkHook(async () => {
			expect(mocks.updateWhere).toHaveBeenCalled();
			events.push("copy");
			return async () => {
				events.push("cleanup");
			};
		});
		mocks.transaction.mockImplementationOnce(async (cb) => {
			const result = await cb(mocks.tx);
			events.push("commit");
			return result;
		});

		await linkAnonymousAccount({ fromUserId: "guest-123", toUserId: "user-456" });
		expect(events).toEqual(["copy", "commit", "cleanup"]);
	});

	it("preserves originals when the database transition fails", async () => {
		const cleanup = vi.fn();
		setAccountLinkHook(async () => cleanup);
		mocks.transaction.mockRejectedValueOnce(new Error("Database unavailable"));

		await expect(linkAnonymousAccount({ fromUserId: "guest-123", toUserId: "user-456" })).rejects.toThrow(
			"Database unavailable",
		);
		expect(cleanup).not.toHaveBeenCalled();
	});

	it("does not reject a committed link when its cleanup fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		setAccountLinkHook(async () => async () => {
			throw new Error("Cleanup unavailable");
		});

		await expect(linkAnonymousAccount({ fromUserId: "guest-123", toUserId: "user-456" })).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("updates document ownership, rewrites upload URLs in DB, and executes registered hooks", async () => {
		const hook = vi.fn().mockResolvedValue(undefined);
		setAccountLinkHook(hook);

		await linkAnonymousAccount({
			fromUserId: "guest-123",
			toUserId: "user-456",
		});

		expect(mocks.transaction).toHaveBeenCalledOnce();

		// CAREEROS (P1-T04): resumes, their versions, redirects and statistics move through one definer function,
		// into the target account's organization; there is no direct update of the resume tables any more.
		// CAREEROS (P1-T05): cover letters and their versions move through a second definer function.
		// CAREEROS (P1-T06): the application profile, pipeline, lanes and applications move through a third.
		// CAREEROS (P1-T09): the guest's pending erasure prefixes are read through a fourth definer call.
		expect(mocks.execute).toHaveBeenCalledTimes(4);
		expect(JSON.stringify(mocks.execute.mock.calls[3]?.[0])).toContain("careeros_guest_cleanup_prefixes");
		const moveQuery = JSON.stringify(mocks.execute.mock.calls[0]?.[0]);
		const letterMoveQuery = JSON.stringify(mocks.execute.mock.calls[1]?.[0]);
		expect(letterMoveQuery).toContain("careeros_move_guest_cover_letters");
		expect(letterMoveQuery).toContain("guest-123");
		expect(letterMoveQuery).toContain("org-user-456");
		expect(mocks.update.mock.calls.some((call) => call[0] === schema.coverLetter)).toBe(false);
		expect(mocks.update.mock.calls.some((call) => call[0] === schema.coverLetterVersion)).toBe(false);
		expect(moveQuery).toContain("careeros_move_guest_resumes");
		expect(moveQuery).toContain("guest-123");
		expect(moveQuery).toContain("user-456");
		expect(moveQuery).toContain("org-user-456");
		expect(mocks.update.mock.calls.some((call) => call[0] === schema.resume)).toBe(false);
		expect(mocks.update.mock.calls.some((call) => call[0] === schema.resumeVersion)).toBe(false);
		expect(mocks.update.mock.calls.some((call) => call[0] === schema.resumeSlugRedirect)).toBe(false);

		const applicationMoveQuery = JSON.stringify(mocks.execute.mock.calls[2]?.[0]);
		expect(applicationMoveQuery).toContain("careeros_move_guest_applications");
		expect(applicationMoveQuery).toContain("guest-123");
		expect(applicationMoveQuery).toContain("user-456");
		expect(applicationMoveQuery).toContain("org-user-456");
		for (const table of [
			schema.application,
			schema.applicationLane,
			schema.applicationPipeline,
			schema.applicationProfile,
		])
			expect(mocks.update.mock.calls.some((call) => call[0] === table)).toBe(false);

		// Check hook execution
		expect(hook).toHaveBeenCalledWith({
			fromUserId: "guest-123",
			toUserId: "user-456",
			excludedStoragePrefixes: [],
		});
	});

	it("reports the definer function's conflicts as CONFLICT replies", async () => {
		for (const [code, message] of [
			["CR001", "private application profile"],
			["CR002", "exceeds 40 active lanes"],
		] as const) {
			mocks.execute.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
			mocks.execute.mockRejectedValueOnce(Object.assign(new Error("Failed query"), { cause: { code } }));
			await expect(linkAnonymousAccount({ fromUserId: "guest-123", toUserId: "user-456" })).rejects.toMatchObject({
				status: "CONFLICT",
				body: { message: expect.stringContaining(message) },
			});
		}
		// Anything else is not turned into a conflict.
		mocks.execute.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
		mocks.execute.mockRejectedValueOnce(new Error("Database unavailable"));
		await expect(linkAnonymousAccount({ fromUserId: "guest-123", toUserId: "user-456" })).rejects.toThrow(
			"Database unavailable",
		);
	});

	it("does nothing when fromUserId equals toUserId", async () => {
		const hook = vi.fn().mockResolvedValue(undefined);
		setAccountLinkHook(hook);

		await linkAnonymousAccount({ fromUserId: "user-1", toUserId: "user-1" });

		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(hook).not.toHaveBeenCalled();
	});
});
