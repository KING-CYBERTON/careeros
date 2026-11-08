// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

const access = vi.hoisted(() => ({ canManage: false, orgAdmin: "denied" as "denied" | "allowed" | "loading" }));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: object) => ({ options }),
	Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
	Outlet: () => null,
	useRouterState: () => "/dashboard/settings",
}));
vi.mock("@/features/organization/queries", () => ({ useCanManageMembers: () => access.canManage }));
// CAREEROS (P3-T08): the Org Admin entries need an organization that is not a personal workspace
vi.mock("@/features/org-admin/queries", () => ({ useOrgAdminAccess: () => access.orgAdmin }));
vi.mock("@/features/settings/root", () => ({ popTransition: undefined }));

vi.stubGlobal("__APP_VERSION__", "test");
i18n.loadAndActivate({ locale: "en", messages: {} });
const { Route } = (await import("@/routes/dashboard/settings/route")) as unknown as {
	Route: { options: { component: () => React.ReactNode } };
};

const renderNav = () => {
	const Component = Route.options.component as React.ComponentType;
	return render(
		<I18nProvider i18n={i18n}>
			<Component />
		</I18nProvider>,
	);
};

afterEach(() => {
	access.canManage = false;
	access.orgAdmin = "denied";
});

it("hides Branding and Domains from a member", () => {
	renderNav();
	expect(screen.getByText("Preferences")).toBeTruthy();
	expect(screen.queryByText("Branding")).toBeNull();
	expect(screen.queryByText("Domains")).toBeNull();
});

it("shows Branding and Domains to an owner or admin", () => {
	access.canManage = true;
	renderNav();
	expect(screen.getByText("Branding")).toBeTruthy();
	expect(screen.getByText("Domains")).toBeTruthy();
});

it("shows the Org Admin pages only to an admin of an organization", () => {
	access.canManage = true;
	renderNav();
	expect(screen.queryByText("Cohorts")).toBeNull();
	expect(screen.queryByText("Analytics")).toBeNull();
	cleanup();
	access.orgAdmin = "allowed";
	renderNav();
	for (const label of ["Cohorts", "Analytics", "AI usage", "Audit log"]) expect(screen.getByText(label)).toBeTruthy();
});
