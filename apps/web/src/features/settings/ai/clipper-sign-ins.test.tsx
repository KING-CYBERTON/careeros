// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const clipper = vi.hoisted(() => ({ listTokens: vi.fn(), revokeToken: vi.fn() }));
vi.mock("@/libs/orpc/client", () => ({ client: { clipper } }));

i18n.loadAndActivate({ locale: "en", messages: {} });
const { ClipperSignInsSection } = await import("./clipper-sign-ins");

const row = {
	id: "token-1",
	organizationId: "org-1",
	organizationName: "Acme Careers",
	host: "acme.example.org",
	label: "Chrome on Windows",
	createdAt: "2026-10-01T10:00:00.000Z",
	lastUsedAt: null,
	expiresAt: "2027-01-01T10:00:00.000Z",
};

function renderSection() {
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<ClipperSignInsSection />
			</QueryClientProvider>
		</I18nProvider>,
	);
}

it("lists the member's sign-ins and revokes one", async () => {
	clipper.listTokens.mockResolvedValue([row]);
	clipper.revokeToken.mockResolvedValue({ revoked: true });
	renderSection();

	expect(await screen.findByText("Acme Careers")).toBeTruthy();
	expect(screen.getByText("Chrome on Windows")).toBeTruthy();
	const item = screen.getByText("Acme Careers").closest("li");
	if (!item) throw new Error("The sign-in row is missing");
	fireEvent.click(within(item).getByRole("button", { name: /Revoke/ }));
	await waitFor(() => expect(clipper.revokeToken).toHaveBeenCalledWith({ id: "token-1" }));
});

it("says so when there are no sign-ins", async () => {
	clipper.listTokens.mockResolvedValue([]);
	renderSection();
	expect(await screen.findByText("No Job Clipper sign-ins yet.")).toBeTruthy();
});
