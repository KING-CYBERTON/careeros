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
