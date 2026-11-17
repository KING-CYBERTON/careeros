import { describe, expect, it, vi } from "vite-plus/test";
import { QueryClient } from "@tanstack/react-query";
import { loadRootContext, sessionQueryKey } from "./root-context";

const getSessionMock = vi.hoisted(() => vi.fn());
const flagsGetMock = vi.hoisted(() => vi.fn().mockResolvedValue({ disableSignups: false, disableEmailAuth: false }));
const entitlementsMock = vi.hoisted(() => vi.fn());

vi.mock("./auth/session", () => ({
	getSession: getSessionMock,
}));

vi.mock("./locale", () => ({
	getLocale: () => "en-US",
	loadLocale: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./orpc/client", () => ({
	client: {
		flags: {
			get: flagsGetMock,
		},
		// CAREEROS (P3-T02)
		organization: { entitlements: entitlementsMock },
	},
}));

vi.mock("./theme", () => ({
	getTheme: () => "system",
}));

describe("loadRootContext", () => {
	it("loads root context with freshly fetched session", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const mockSession = {
			user: { id: "user-1", name: "Alice" },
			session: { id: "sess-1" },
		};
		getSessionMock.mockResolvedValueOnce(mockSession);

		const context = await loadRootContext(queryClient);
		expect(context.session).toEqual(mockSession);
	});

	it("retains cached session when getSession encounters a transient error on refresh", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const cachedSession = {
			user: { id: "user-1", name: "Alice" },
			session: { id: "sess-1" },
		};
		queryClient.setQueryData(sessionQueryKey, cachedSession);
		// Mark stale/invalid so getSession is invoked
		void queryClient.invalidateQueries({ queryKey: sessionQueryKey });

		getSessionMock.mockRejectedValueOnce(new Error("Too many requests. Please try again later."));

		const context = await loadRootContext(queryClient);
		expect(context.session).toEqual(cachedSession);
	});

	it("re-throws error when getSession fails and there is no cached session", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		getSessionMock.mockRejectedValueOnce(new Error("Session check failed with status 500"));

		await expect(loadRootContext(queryClient)).rejects.toThrow("Session check failed with status 500");
	});

	// CAREEROS (P3-T02): the organization's resolved features join the flags in the router context.
	describe("organization flags", () => {
		const entitlements = {
			planId: "pro",
			status: "suspended",
			readOnly: true,
			seatLimit: null,
			seatsUsed: 3,
			features: { custom_domain: true, sso: false },
		};
		const signedIn = (organizationId: string | null) => ({
			user: { id: "user-1", name: "Alice" },
			session: { id: "sess-1", activeOrganizationId: organizationId },
		});

		it("adds the features and status of the active organization", async () => {
			const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			getSessionMock.mockResolvedValueOnce(signedIn("org-1"));
			entitlementsMock.mockResolvedValueOnce(entitlements);

			const { flags } = await loadRootContext(queryClient);
			expect(flags.features).toEqual({ custom_domain: true, sso: false });
			expect(flags.organization).toEqual({
				planId: "pro",
				status: "suspended",
				readOnly: true,
				seatLimit: null,
				seatsUsed: 3,
			});
			expect(flags.disableSignups).toBe(false);
		});

		it("asks again for another organization after a switch", async () => {
			const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			entitlementsMock.mockClear();
			entitlementsMock.mockResolvedValue(entitlements);
			getSessionMock.mockResolvedValueOnce(signedIn("org-a"));
			await loadRootContext(queryClient);
			queryClient.removeQueries({ queryKey: sessionQueryKey });
			getSessionMock.mockResolvedValueOnce(signedIn("org-b"));
			await loadRootContext(queryClient);
			expect(entitlementsMock).toHaveBeenCalledTimes(2);
		});

		it("has no features and no organization without an active organization or when the read fails", async () => {
			const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			getSessionMock.mockResolvedValueOnce(signedIn(null));
			expect((await loadRootContext(queryClient)).flags).toMatchObject({ features: {}, organization: null });

			const failing = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			getSessionMock.mockResolvedValueOnce(signedIn("org-1"));
			entitlementsMock.mockRejectedValueOnce(new Error("down"));
			expect((await loadRootContext(failing)).flags).toMatchObject({ features: {}, organization: null });
		});
	});
});
