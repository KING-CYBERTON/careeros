// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

// CAREEROS (P3-T06): every status the summary shows, a seat count below the members refused, prices read from the plan
// data, owner-only actions hidden from an admin, the billing-off page, the return page's wait, and the banners.

const state = vi.hoisted(() => ({
	billing: undefined as unknown,
	invoices: { invoices: [] } as unknown,
	credits: { used: 40, allowance: 100 } as unknown,
	billingError: null as unknown,
	checkout: vi.fn(),
	flags: { organization: { status: "active" } } as unknown,
	role: "owner" as "owner" | "admin" | "member" | "unknown",
}));

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: object) => ({ options }),
	Link: ({ children }: { children: React.ReactNode }) => <a href="/x">{children}</a>,
	useRouteContext: () => ({ flags: state.flags }),
}));
vi.mock("@/hooks/use-confirm", () => ({ useConfirm: () => async () => "" }));
vi.mock("@/features/organization/queries", () => ({
	useMembers: () => ({ data: state.role === "unknown" ? undefined : { me: { role: state.role } } }),
}));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		billing: {
			key: () => ["billing"],
			get: {
				queryOptions: () => ({
					queryKey: ["billing", "get"],
					queryFn: async () => {
						if (state.billingError) throw state.billingError;
						return state.billing;
					},
				}),
			},
			invoices: { queryOptions: () => ({ queryKey: ["billing", "invoices"], queryFn: async () => state.invoices }) },
			checkout: { mutationOptions: () => ({ mutationFn: state.checkout }) },
			startTrial: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
			changeSeats: { mutationOptions: () => ({ mutationFn: async () => ({ accepted: true }) }) },
			cancel: { mutationOptions: () => ({ mutationFn: async () => ({ accepted: true }) }) },
			portal: { mutationOptions: () => ({ mutationFn: async () => ({ url: "https://portal.test" }) }) },
		},
		aiUsage: { summary: { queryOptions: () => ({ queryKey: ["ai"], queryFn: async () => state.credits }) } },
		organization: { key: () => ["organization"] },
	},
}));

i18n.loadAndActivate({ locale: "en", messages: {} });

const { BillingPage } = await import("./billing-page");
const { BillingReturn } = await import("./return-page");
const { BillingBanner } = await import("./billing-banner");
const { BillingSummary } = await import("./summary");
const { CheckoutForm } = await import("./plans");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const wrap = (ui: React.ReactNode) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		<I18nProvider i18n={i18n}>{ui}</I18nProvider>
	</QueryClientProvider>
);

const freePlan = (id: string, name: string) => ({
	id,
	name,
	pricingModel: "flat",
	seatLimit: 5,
	priceMonthlyUsdCents: 0,
	priceAnnualUsdCents: 0,
	priceMonthlyKes: 0,
	priceAnnualKes: 0,
	aiCreditsPerSeat: 50,
	features: {},
	selfService: false,
});

const plans = [
	freePlan("personal", "Personal"),
	freePlan("trial", "Trial"),
	{
		id: "starter",
		name: "Starter",
		pricingModel: "per_seat",
		seatLimit: 50,
		priceMonthlyUsdCents: 1234,
		priceAnnualUsdCents: 12_340,
		priceMonthlyKes: 1777,
		priceAnnualKes: 17_770,
		aiCreditsPerSeat: 300,
		features: {},
		selfService: true,
	},
	{
		id: "enterprise",
		name: "Enterprise",
		pricingModel: "flat",
		seatLimit: null,
		priceMonthlyUsdCents: null,
		priceAnnualUsdCents: null,
		priceMonthlyKes: null,
		priceAnnualKes: null,
		aiCreditsPerSeat: 900,
		features: {},
		selfService: false,
	},
];

const days = (n: number) => new Date(Date.now() + n * 86_400_000);

const make = (over: Record<string, unknown> = {}, sub: Record<string, unknown> = {}) => ({
	planId: "starter",
	status: "active",
	subscription: {
		status: "active",
		provider: "fake",
		seats: 10,
		interval: "month",
		currentPeriodStart: days(-5),
		currentPeriodEnd: days(25),
		trialEndsAt: null,
		graceEndsAt: null,
		...sub,
	},
	memberCount: 4,
	billingEnabled: true,
	canManage: true,
	canStartTrial: false,
	plans,
	...over,
});

beforeEach(() => {
	state.billing = make();
	state.invoices = { invoices: [] };
	state.billingError = null;
	state.flags = { organization: { status: "active" } };
	state.role = "owner";
	state.checkout.mockReset();
});
afterEach(cleanup);

const page = async () => {
	render(wrap(<BillingPage />));
	await screen.findByTestId("billing-summary");
};

it("shows each status of the organization", async () => {
	const cases: [Record<string, unknown>, Record<string, unknown>, string, RegExp][] = [
		[{ status: "trial" }, { status: "trialing", trialEndsAt: days(9) }, "Trial", /9 days left/],
		[{}, {}, "Active", /Renews or ends/],
		[{}, { status: "canceled" }, "Ends at period end", /keeps working until/],
		[{ status: "past_due" }, { status: "past_due", graceEndsAt: days(4) }, "Past due", /Payment failed/],
		[{ status: "suspended" }, {}, "Suspended", /view and export/],
	];
	for (const [top, sub, label, detail] of cases) {
		state.billing = make(top, sub);
		const { unmount } = render(wrap(<BillingPage />));
		await screen.findByTestId("billing-summary");
		expect(screen.getByTestId("billing-status").textContent).toBe(label);
		expect(screen.getByTestId("billing-status-detail").textContent).toMatch(detail);
		unmount();
	}
});

it("shows seats used against the paid seats, and the AI credits left", async () => {
	await page();
	expect(screen.getByTestId("billing-seats").textContent).toBe("4 of 10");
	await waitFor(() => expect(screen.getByTestId("billing-credits").textContent).toBe("40 used, 60 left"));
});

it("renders prices from the plan data and never invents one", async () => {
	await page();
	expect(screen.queryByTestId("plan-card-trial")).toBeNull();
	expect(screen.queryByTestId("plan-card-personal")).toBeNull();
	const starter = screen.getByTestId("plan-card-starter");
	expect(starter.textContent).toMatch(/KES\s1,777/);
	expect(starter.textContent).toContain("$12.34");
	expect(starter.textContent).toContain("$123.40");
	expect(starter.textContent).toContain("per seat");
	expect(screen.getByTestId("plan-card-enterprise").textContent).toContain("Contact us");
	expect(screen.getByTestId("plan-card-starter").textContent).toContain("Current plan");
});

it("refuses a seat count below the current members, with a message", async () => {
	await page();
	fireEvent.click(screen.getByRole("button", { name: "Change Starter" }));
	const form = await screen.findByTestId("checkout-form");
	const input = form.querySelector("input[type=number]") as HTMLInputElement;
	fireEvent.change(input, { target: { value: "2" } });
	expect(screen.getByTestId("seat-error").textContent).toMatch(/4 members.*at least 4 seats/);
	const submit = screen.getByRole("button", { name: "Continue to payment" }) as HTMLButtonElement;
	expect(submit.disabled).toBe(true);
	fireEvent.change(input, { target: { value: "6" } });
	expect(screen.queryByTestId("seat-error")).toBeNull();
	expect((screen.getByRole("button", { name: "Continue to payment" }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows the card or M-Pesa choice only when asked to, with a note for each", () => {
	const props = {
		plan: plans[0] as never,
		memberCount: 1,
		initialSeats: 1,
		locale: "en",
		busy: false,
		onSubmit: vi.fn(),
		onCancel: vi.fn(),
	};
	const { unmount } = render(wrap(<CheckoutForm {...props} methodSelectable={false} />));
	expect(screen.queryByTestId("method-note")).toBeNull();
	unmount();
	render(wrap(<CheckoutForm {...props} methodSelectable />));
	expect(screen.getByTestId("method-note").textContent).toBe("Card renews automatically.");
	fireEvent.click(screen.getByRole("radio", { name: "M-Pesa" }));
	expect(screen.getByTestId("method-note").textContent).toMatch(/one period at a time/);
});

it("shows the card or M-Pesa selector on the checkout page and sends the method, card by default", async () => {
	state.checkout.mockResolvedValue({ redirectUrl: null, stkPushRequested: false });
	await page();
	fireEvent.click(screen.getByRole("button", { name: "Change Starter" }));
	await screen.findByTestId("checkout-form");
	expect(screen.getByRole("radio", { name: "Card" })).toBeTruthy();
	expect(screen.getByRole("radio", { name: "M-Pesa" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
	await waitFor(() => expect(state.checkout).toHaveBeenCalled());
	expect(state.checkout.mock.calls[0]?.[0]).toMatchObject({ planId: "starter", interval: "month", method: "card" });
});

it("sends mpesa when M-Pesa is chosen", async () => {
	state.checkout.mockResolvedValue({ redirectUrl: null, stkPushRequested: false });
	await page();
	fireEvent.click(screen.getByRole("button", { name: "Change Starter" }));
	await screen.findByTestId("checkout-form");
	fireEvent.click(screen.getByRole("radio", { name: "M-Pesa" }));
	fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
	await waitFor(() => expect(state.checkout).toHaveBeenCalled());
	expect(state.checkout.mock.calls[0]?.[0]).toMatchObject({ method: "mpesa" });
});

it("hides every action from an admin", async () => {
	state.billing = make({ canManage: false });
	await page();
	expect(screen.queryByRole("button", { name: /Change Starter|Choose/ })).toBeNull();
	expect(screen.queryByRole("button", { name: "Update seats" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Cancel subscription" })).toBeNull();
	expect(screen.getByTestId("billing-owner-only")).toBeTruthy();
});

it("shows the owner the manage actions of a paying organization", async () => {
	await page();
	expect(screen.getByRole("button", { name: "Update card or cancel" })).toBeTruthy();
	expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeTruthy();
});

it("shows the plan read-only when billing is off", async () => {
	state.billing = make({ billingEnabled: false, canManage: true });
	await page();
	expect(screen.getByTestId("billing-off").textContent).toMatch(/managed by the platform/);
	expect(screen.queryByRole("button", { name: /Choose|Change Starter/ })).toBeNull();
	expect(screen.queryByRole("button", { name: "Update card or cancel" })).toBeNull();
});

it("tells a member the page is for owners and admins", async () => {
	state.billingError = { code: "FORBIDDEN", message: "no" };
	render(wrap(<BillingPage />));
	expect(await screen.findByTestId("billing-denied")).toBeTruthy();
});

it("lists payments and offers a receipt for each", async () => {
	state.invoices = {
		invoices: [
			{
				id: "a1",
				date: new Date("2026-11-01T10:00:00Z"),
				amount: 123_400,
				currency: "KES",
				provider: "fake",
				method: "mpesa",
				reference: "REF-1",
				planId: "starter",
				seats: 4,
				periodStart: new Date("2026-11-01T00:00:00Z"),
				periodEnd: new Date("2026-12-01T00:00:00Z"),
			},
		],
	};
	await page();
	const row = await screen.findByTestId("invoice-row");
	expect(row.textContent).toMatch(/KES\s1,234/);
	expect(row.textContent).toContain("M-Pesa");
	expect(row.textContent).toContain("REF-1");
	expect(row.textContent).toContain("Receipt");
});

it("shows the summary without prices anywhere outside the plan table", async () => {
	render(wrap(<BillingSummary billing={make() as never} credits={undefined} method={null} locale="en" />));
	expect(screen.getByTestId("billing-summary").parentElement?.textContent).not.toMatch(/[$]|KES/);
});

// --- return page ----------------------------------------------------------------------------------------------

it("waits on the return page until the plan changes, then confirms", async () => {
	state.billing = make(
		{ planId: "personal", status: "active" },
		{ status: "none", provider: "none", currentPeriodStart: null },
	);
	render(wrap(<BillingReturn pollMs={20} timeoutMs={5000} />));
	expect((await screen.findByTestId("billing-return")).textContent).toContain("Payment received, updating your plan");
	state.billing = make({ planId: "starter" });
	await waitFor(() => expect(screen.getByTestId("billing-return").dataset.state).toBe("confirmed"));
});

it("explains a slow confirmation after the timeout", async () => {
	state.billing = make({ planId: "personal" }, { status: "none", provider: "none", currentPeriodStart: null });
	render(wrap(<BillingReturn pollMs={20} timeoutMs={60} />));
	await waitFor(() => expect(screen.getByTestId("billing-return").dataset.state).toBe("slow"));
	expect(screen.getByTestId("billing-return").textContent).toMatch(/may take a few minutes/);
});

it("says a declined payment changed nothing", async () => {
	render(wrap(<BillingReturn result="declined" />));
	expect((await screen.findByTestId("billing-return")).dataset.state).toBe("declined");
});

// --- banners --------------------------------------------------------------------------------------------------

const banner = async () => {
	await act(async () => {
		render(wrap(<BillingBanner />));
	});
};

it("shows the owner the trial ending, past due and suspended banners", async () => {
	const cases: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
		["trial", { status: "trial" }, { status: "trialing", trialEndsAt: days(2) }, "billing-banner-trial_ending"],
		["past_due", { status: "past_due" }, { status: "past_due", graceEndsAt: days(5) }, "billing-banner-past_due"],
		["suspended", { status: "suspended" }, {}, "billing-banner-suspended"],
	];
	for (const [status, top, sub, testId] of cases) {
		state.flags = { organization: { status } };
		state.billing = make(top, sub);
		const { unmount } = render(wrap(<BillingBanner />));
		expect(await screen.findByTestId(testId)).toBeTruthy();
		unmount();
	}
});

it("shows no banner for a trial with more than three days left", async () => {
	state.flags = { organization: { status: "trial" } };
	state.billing = make({ status: "trial" }, { status: "trialing", trialEndsAt: days(10) });
	await banner();
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(screen.queryByTestId("billing-banner-trial_ending")).toBeNull();
});

it("shows a member only a notice to contact the owner, and only when a payment is overdue", async () => {
	state.role = "member";
	state.flags = { organization: { status: "past_due" } };
	await banner();
	expect(screen.getByTestId("billing-banner-member").textContent).toMatch(/contact your organization's owner/);
	cleanup();
	state.flags = { organization: { status: "active" } };
	await banner();
	expect(screen.queryByTestId("billing-banner-member")).toBeNull();
});
