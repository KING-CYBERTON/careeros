// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

// CAREEROS (P3-T07): what the console's layout shows each kind of signed-in user, that the support-session banner shows
// only for an impersonated session, and that the redeem page takes the token out of the address bar.

const state = vi.hoisted(() => ({
	session: undefined as unknown,
	flags: { appUrl: "https://platform.test" } as unknown,
	current: undefined as unknown,
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: object) => ({ options }),
	Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
	Outlet: () => <div data-testid="outlet" />,
	useRouteContext: () => ({ session: state.session, flags: state.flags }),
}));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		impersonation: {
			current: { queryOptions: () => ({ queryKey: ["current"], queryFn: async () => state.current }) },
			end: { mutationOptions: () => ({ mutationFn: async () => ({ ended: true }) }) },
		},
	},
}));
vi.mock("@/libs/auth/client", () => ({ authClient: { signOut: vi.fn(async () => undefined) } }));
vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
	return actual;
});

vi.stubGlobal("__APP_VERSION__", "test");
i18n.loadAndActivate({ locale: "en", messages: {} });

const { AdminLayout } = await import("./layout");
const { ImpersonationBanner } = await import("./impersonation-banner");
const { ImpersonateRedeemPage } = await import("@/features/auth/pages/impersonate-redeem");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const wrap = (ui: React.ReactNode) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		<I18nProvider i18n={i18n}>{ui}</I18nProvider>
	</QueryClientProvider>
);
const user = (extra: Record<string, unknown>) => ({ session: { session: {}, user: { id: "u1", ...extra } } });

afterEach(cleanup);

it("shows a plain 'not found' page to a user who is not an admin", () => {
	state.session = user({ role: "user", twoFactorEnabled: true }).session;
	render(wrap(<AdminLayout />));
	expect(screen.getByTestId("admin-not-found")).toBeTruthy();
	expect(screen.queryByTestId("admin-console")).toBeNull();
});

it("tells an admin without two-factor authentication how to turn it on, and shows no console", () => {
	state.session = user({ role: "admin", twoFactorEnabled: false }).session;
	render(wrap(<AdminLayout />));
	expect(screen.getByTestId("admin-two-factor-required")).toBeTruthy();
	expect(screen.queryByTestId("outlet")).toBeNull();
});

it("shows the console to an admin with two-factor authentication", () => {
	state.session = user({ role: "support,admin", twoFactorEnabled: true }).session;
	render(wrap(<AdminLayout />));
	expect(screen.getByTestId("admin-console")).toBeTruthy();
	expect(screen.getByTestId("outlet")).toBeTruthy();
	expect(screen.getByText("Organizations")).toBeTruthy();
});

it("does not treat a role that only contains the letters as admin", () => {
	state.session = user({ role: "administrator", twoFactorEnabled: true }).session;
	render(wrap(<AdminLayout />));
	expect(screen.getByTestId("admin-not-found")).toBeTruthy();
});

it("shows the support-session banner only for an impersonated session", async () => {
	state.session = { session: { impersonatedBy: null }, user: { id: "m1" } };
	const { unmount } = render(wrap(<ImpersonationBanner />));
	expect(screen.queryByTestId("impersonation-banner")).toBeNull();
	unmount();

	state.session = { session: { impersonatedBy: "admin-1" }, user: { id: "m1" } };
	state.current = { id: "i1", userName: "Member", expiresAt: new Date(Date.now() + 30 * 60_000) };
	render(wrap(<ImpersonationBanner />));
	expect(screen.getByTestId("impersonation-banner")).toBeTruthy();
	expect(screen.getByText("End now")).toBeTruthy();
	await waitFor(() => expect(screen.getByTestId("impersonation-banner").textContent).toMatch(/\(\d+ min\)/));
});

beforeEach(() => {
	window.history.replaceState(null, "", "/");
});

it("removes the token from the address bar before it posts it, and shows a calm failure", async () => {
	window.history.replaceState(null, "", "/auth/impersonate#id=imp-id-1234567890ab&token=tok-1234567890abcdef");
	const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: "impersonation_invalid" }), { status: 400 }));
	vi.stubGlobal("fetch", fetchMock);
	await act(async () => {
		render(wrap(<ImpersonateRedeemPage />));
	});
	expect(window.location.hash).toBe("");
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
	expect(call[0]).toBe("/api/careeros/impersonation/redeem");
	expect(JSON.parse(String(call[1].body))).toEqual({ id: "imp-id-1234567890ab", token: "tok-1234567890abcdef" });
	await waitFor(() => expect(screen.getByTestId("impersonate-failed")).toBeTruthy());
});

it("fails at once without calling the server when the fragment is missing", async () => {
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	await act(async () => {
		render(wrap(<ImpersonateRedeemPage />));
	});
	expect(fetchMock).not.toHaveBeenCalled();
	await waitFor(() => expect(screen.getByTestId("impersonate-failed")).toBeTruthy());
});
