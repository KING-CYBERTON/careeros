// CAREEROS (P1-T02): shared test helper. Upstream router tests call `protectedProcedure` with a user that has no
// organization. Every protected procedure now needs an active organization, so these tests get a fixed one here
// instead of each file being edited. Tests of the organization behaviour itself (`org-context.test.ts`) declare their
// own `vi.mock("@careeros/tenancy")`, which takes precedence over this one.
import { vi } from "vite-plus/test";

export const TEST_ORGANIZATION_ID = "org_test";

// P2-T03: the real module underneath, so exports added later (hostTrustedOrigins, bustHostCache, ...) cannot go missing.
vi.mock("@careeros/tenancy", async (importOriginal) => ({
	...(await importOriginal<typeof import("@careeros/tenancy")>()),
	ORG_CONTEXT_REQUIRED: true,
	TenancyError: class TenancyError extends Error {},
	// A runner that executes at once; tests read `captureOrgScope.mock.results` to see which work it wrapped.
	captureOrgScope: vi.fn(() => vi.fn(<T>(fn: () => Promise<T>) => fn())),
	currentOrgId: () => TEST_ORGANIZATION_ID,
	// P2-T03: no request host is registered in unit tests, so the platform rules apply.
	currentHost: () => undefined,
	requireOrgId: () => TEST_ORGANIZATION_ID,
	resolveOrgForAuthentication: () => Promise.resolve(TEST_ORGANIZATION_ID),
	resolveOrgForRequest: () => Promise.resolve(TEST_ORGANIZATION_ID),
	withOrgContext: <T>(_organizationId: string, fn: () => Promise<T>) => fn(),
}));

// P3-T02: `protectedProcedure` reads the organization's entitlements before a write. Upstream router tests have no
// billing tables, so they get an active organization on a plan with every feature. Tests of the enforcement itself
// (`entitlements.test.ts`, `*.integration.test.ts`) declare their own `vi.mock("@careeros/billing")`, which takes precedence.
vi.mock("@careeros/billing", async (importOriginal) => {
	const original = await importOriginal<typeof import("@careeros/billing")>();
	return {
		...original,
		getEntitlements: vi.fn(() =>
			Promise.resolve({
				planId: "pro",
				status: "active",
				seatLimit: null,
				seatsUsed: 1,
				// CAREEROS (P3-T03): the pro plan's pool. A zero pool would make the AI quota check refuse every platform and
				// server-managed AI call in these tests.
				aiCreditsPerSeat: 300,
				aiCreditsTotal: 300,
				features: Object.fromEntries(original.FEATURE_KEYS.map((key) => [key, true])),
				overageAllowed: false,
				discoveryAiTopN: 25,
				readOnly: false,
			}),
		),
	};
});
