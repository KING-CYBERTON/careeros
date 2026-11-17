// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const stored = vi.hoisted(() => ({
	appName: "Acme",
	logoUrl: null as string | null,
	faviconUrl: null as string | null,
	primaryColor: "#1a56db" as string | null,
	secondaryColor: null as string | null,
	font: null as string | null,
	emailFromName: null as string | null,
	emailReplyTo: null as string | null,
	supportUrl: null as string | null,
	termsUrl: null as string | null,
	privacyUrl: null as string | null,
	updatedAt: new Date(0),
}));
const update = vi.hoisted(() => vi.fn(async (input: object) => ({ ...stored, ...input })));
const members = vi.hoisted(() => ({ role: "owner" }));
const navigate = vi.hoisted(() => vi.fn());
const toastAdd = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useNavigate: () => navigate,
}));
vi.mock("@/features/organization/queries", () => ({
	useMembers: () => ({ isLoading: false, data: { me: { role: members.role } } }),
}));
vi.mock("@/hooks/use-confirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: toastAdd, close: vi.fn() } }));
vi.mock("@/libs/orpc/client", () => {
	const mutation = (fn: (input: never) => unknown) => ({
		mutationOptions: (options: object) => ({ ...options, mutationFn: fn }),
	});
	return {
		orpc: {
			branding: {
				get: {
					queryOptions: () => ({ queryKey: ["branding"], queryFn: async () => stored }),
					queryKey: () => ["branding"],
				},
				update: mutation(update as never),
				uploadLogo: mutation(vi.fn() as never),
				uploadFavicon: mutation(vi.fn() as never),
				deleteLogo: mutation(vi.fn() as never),
				deleteFavicon: mutation(vi.fn() as never),
			},
		},
	};
});
i18n.loadAndActivate({ locale: "en", messages: {} });
const { BrandingSettings } = await import("./branding-page");

const renderPage = () =>
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<BrandingSettings />
			</QueryClientProvider>
		</I18nProvider>,
	);

afterEach(() => {
	vi.clearAllMocks();
	members.role = "owner";
});

it("updates the preview as the inputs change, without saving", async () => {
	renderPage();
	const name = await screen.findByLabelText("App name");
	fireEvent.change(name, { target: { value: "Beta Careers" } });
	expect(screen.getByTestId("brand-preview-name").textContent).toBe("Beta Careers");
	const preview = screen.getByTestId("brand-preview");
	expect(preview.style.getPropertyValue("--accent")).toBe("#1a56db");
	fireEvent.change(screen.getByLabelText("Primary colour"), { target: { value: "#ff0000" } });
	expect(preview.style.getPropertyValue("--accent")).toBe("#ff0000");
	fireEvent.change(screen.getByLabelText("Secondary colour"), { target: { value: "#ffcc00" } });
	expect(preview.style.getPropertyValue("--brand-secondary")).toBe("#ffcc00");
	expect(update).not.toHaveBeenCalled();
});

it("shows a validation message and does not save an invalid colour or link", async () => {
	renderPage();
	fireEvent.change(await screen.findByLabelText("Primary colour"), { target: { value: "blue" } });
	expect(await screen.findByText("Use a colour like #1a56db.")).toBeTruthy();
	fireEvent.change(screen.getByLabelText("Support"), { target: { value: "http://acme.example" } });
	expect(screen.getByText("Use a full https:// address.")).toBeTruthy();
	expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
});

it("warns when the primary colour is hard to see on white, and not for a strong one", async () => {
	renderPage();
	const primary = await screen.findByLabelText("Primary colour");
	expect(screen.queryByTestId("contrast-warning")).toBeNull();
	fireEvent.change(primary, { target: { value: "#ffff00" } });
	expect(screen.getByTestId("contrast-warning").textContent).toContain(
		"This colour may be hard to see on a white background.",
	);
	fireEvent.change(primary, { target: { value: "#1a56db" } });
	expect(screen.queryByTestId("contrast-warning")).toBeNull();
});
it("saves only what changed, with the colour in lower case", async () => {
	renderPage();
	fireEvent.change(await screen.findByLabelText("App name"), { target: { value: "Acme Careers" } });
	fireEvent.change(screen.getByLabelText("Secondary colour"), { target: { value: "#FFCC00" } });
	fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
	await waitFor(() => expect(update).toHaveBeenCalled());
	expect(update.mock.calls[0]?.[0]).toEqual({ appName: "Acme Careers", secondaryColor: "#ffcc00" });
});

it("sends a member who is not an owner or admin back to settings", async () => {
	members.role = "member";
	renderPage();
	await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/dashboard/settings", replace: true }));
	expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
	expect(screen.queryByLabelText("App name")).toBeNull();
});
