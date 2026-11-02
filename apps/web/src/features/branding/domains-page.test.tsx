// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
	info: {
		subdomainHost: "acme.careers.example" as string | null,
		subdomainUrl: "https://acme.careers.example",
		domainsConfigured: true,
		domainLimit: 5,
	},
	domains: [] as object[],
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useNavigate: () => vi.fn(),
}));
vi.mock("@/features/organization/queries", () => ({
	useMembers: () => ({ isLoading: false, data: { me: { role: "admin" } } }),
}));
vi.mock("@/hooks/use-confirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: vi.fn(), close: vi.fn() } }));
vi.mock("@/libs/orpc/client", () => {
	const mutation = { mutationOptions: (options: object) => ({ ...options, mutationFn: vi.fn() }) };
	return {
		orpc: {
			organizationDomain: {
				info: { queryOptions: () => ({ queryKey: ["info"], queryFn: async () => state.info }) },
				list: {
					queryOptions: () => ({ queryKey: ["domains"], queryFn: async () => state.domains }),
					queryKey: () => ["domains"],
				},
				add: mutation,
				recheck: mutation,
				remove: mutation,
			},
		},
	};
});

i18n.loadAndActivate({ locale: "en", messages: {} });
const { DomainsSettings } = await import("./domains-page");

const records = (host: string) => [
	{ type: "TXT", name: `_careeros-verify.${host}`, value: "careeros-verify=abc" },
	{ type: "CNAME", name: host, value: "saas.customers.example" },
];
const domain = (status: string, extra: object = {}) => ({
	id: `id-${status}`,
	hostname: `${status}.acme.example`,
	status,
	records: records(`${status}.acme.example`),
	cfSslStatus: null,
	failureReason: null,
	lastCheckedAt: null,
	verifiedAt: null,
	createdAt: new Date(),
	...extra,
});

const renderPage = () =>
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<DomainsSettings />
			</QueryClientProvider>
		</I18nProvider>,
	);

it("lists every status with its badge, the records of a domain waiting for DNS, and the failure in plain words", async () => {
	state.domains = [
		domain("pending"),
		domain("verified", { cfSslStatus: "pending_validation" }),
		domain("active"),
		domain("failed", { failureReason: "verification_timeout" }),
		domain("removing"),
	];
	renderPage();
	expect(await screen.findAllByTestId("domain-row")).toHaveLength(5);
	expect(screen.getAllByTestId("domain-status").map((node) => node.textContent)).toEqual([
		"Waiting for DNS",
		"Issuing certificate",
		"Active",
		"Failed",
		"Removing",
	]);
	// Records show for the two states that still need DNS work, with a copy button each.
	expect(screen.getAllByTestId("dns-records")).toHaveLength(2);
	expect(screen.getAllByRole("button", { name: "Copy TXT value" }).length).toBeGreaterThan(0);
	expect(screen.getByText(/We didn't find the ownership record in time/)).toBeTruthy();
	expect(screen.getByTestId("domain-ssl").textContent).toContain("pending_validation");
	expect(screen.getByTestId("subdomain-host").textContent).toBe("acme.careers.example");
	expect(screen.getByText("5 of 5 domains used.")).toBeTruthy();
});

it("shows a neutral notice instead of the form when custom domains are not set up", async () => {
	state.info = { ...state.info, domainsConfigured: false };
	state.domains = [];
	renderPage();
	expect(await screen.findByTestId("domains-not-configured")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
	// The address that always works still shows.
	expect(screen.getByTestId("subdomain-host")).toBeTruthy();
});
