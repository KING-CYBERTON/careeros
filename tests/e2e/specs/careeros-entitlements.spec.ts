import { setAccountOrganizationPlan, setPlanSeatLimit } from "../fixtures/careeros-org";
import { expect, test } from "../fixtures/test";

// P3-T02: seat limits and suspension are enforced by the server and explained on screen.
// The Starter plan's seat limit is lowered for the test and restored afterwards, so the spec runs serially.
test.describe.configure({ mode: "serial" });

test("an organization at its seat limit cannot invite more people until a seat is freed", async ({
	authPage: page,
	account,
}) => {
	let previousLimit: number | null = null;
	try {
		// One seat is taken by the owner, so a limit of 2 leaves exactly one for an invitation.
		previousLimit = await setPlanSeatLimit("starter", 2);
		await setAccountOrganizationPlan(account, "starter");

		await page.goto("/dashboard/settings/members");
		await expect(page.getByRole("heading", { name: "Members & invites" })).toBeVisible();

		const first = `seat-a-${account.username}@example.test`;
		await page.getByLabel("Email address", { exact: true }).fill(first);
		await page.getByRole("button", { name: "Send invitation" }).click();
		await expect(page.getByTestId("invitation-row").filter({ hasText: first })).toBeVisible();

		// The pending invitation holds the last seat, so the next one is refused with a readable message.
		const second = `seat-b-${account.username}@example.test`;
		await page.getByLabel("Email address", { exact: true }).fill(second);
		await page.getByRole("button", { name: "Send invitation" }).click();
		await expect(page.getByText("This organization has no free seats")).toBeVisible();
		await expect(page.getByTestId("invitation-row").filter({ hasText: second })).toHaveCount(0);

		// Cancelling the first invitation frees the seat.
		await page.getByRole("button", { name: `Cancel invitation for ${first}` }).click();
		await expect(page.getByTestId("invitation-row").filter({ hasText: first })).toHaveCount(0);
		await page.getByLabel("Email address", { exact: true }).fill(second);
		await page.getByRole("button", { name: "Send invitation" }).click();
		await expect(page.getByTestId("invitation-row").filter({ hasText: second })).toBeVisible();
	} finally {
		if (previousLimit !== null) await setPlanSeatLimit("starter", previousLimit);
		await setAccountOrganizationPlan(account, "personal");
	}
});

test("a suspended organization shows a banner and refuses changes, and recovers when reactivated", async ({
	authPage: page,
	account,
	baseURL,
}) => {
	await setAccountOrganizationPlan(account, "pro", "suspended");
	try {
		await page.goto("/dashboard");
		await expect(page.getByTestId("suspended-banner")).toBeVisible();

		// The server refuses the write whatever the screen shows.
		const refused = await page.request.patch("/api/openapi/branding", {
			data: { appName: "Suspended Co" },
			headers: { origin: String(baseURL) },
		});
		expect(refused.status()).toBe(403);
		expect(await refused.text()).toContain("ORG_SUSPENDED");

		await setAccountOrganizationPlan(account, null, "active");
		await page.reload();
		await expect(page.getByTestId("suspended-banner")).toHaveCount(0);
	} finally {
		await setAccountOrganizationPlan(account, "personal", "active");
	}
});
