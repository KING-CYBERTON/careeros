// CAREEROS (P1-T02): shared test helper. Upstream MCP tests authenticate a user without an organization. The MCP route
// now needs an active organization, so these tests get a fixed one here instead of each file being edited. Tests of the
// organization behaviour itself (`mcp/handler-org.test.ts`) declare their own `vi.mock("@careeros/tenancy")`.
import { vi } from "vite-plus/test";

vi.mock("@careeros/tenancy", () => ({
	resolveOrgForAuthentication: () => Promise.resolve("org_test"),
	withOrgContext: <T>(_organizationId: string, fn: () => Promise<T>) => fn(),
}));
