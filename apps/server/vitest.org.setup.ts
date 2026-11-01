// CAREEROS (P1-T02): shared test helper. Upstream MCP tests authenticate a user without an organization. The MCP route
// now needs an active organization, so these tests get a fixed one here instead of each file being edited. Tests of the
// organization behaviour itself (`mcp/handler-org.test.ts`) declare their own `vi.mock("@careeros/tenancy")`.
import { vi } from "vite-plus/test";

vi.mock("@careeros/tenancy", () => ({
	ORG_CONTEXT_REQUIRED: true,
	requireOrgId: () => "org_test",
	currentOrgId: () => "org_test",
	resolveOrgForAuthentication: () => Promise.resolve("org_test"),
	captureOrgScope: () => (fn: () => Promise<unknown>) => fn(),
	withOrgContext: <T>(_organizationId: string, fn: () => Promise<T>) => fn(),
	// P2-T03: unit tests run on the platform host, with no organization hosts configured.
	currentHost: () => undefined,
	resolveHost: () => Promise.resolve({ kind: "platform" }),
	runWithHost: <T>(_host: unknown, fn: () => T) => fn(),
	TenancyError: class TenancyError extends Error {
		readonly code: string;
		constructor(code: string) {
			super(code);
			this.code = code;
		}
	},
}));
