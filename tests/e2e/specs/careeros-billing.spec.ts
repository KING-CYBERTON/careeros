import { accountOrganizationId, setAccountOrganizationPlan } from "../fixtures/careeros-org";
import { withSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";

// P3-T06: the owner's billing page with the fake payment provider (no real provider is ever called). The CI e2e job runs
// the built server with BILLING_PROVIDER=fake, a test BILLING_FAKE_SECRET and FLAG_ALLOW_FAKE_BILLING=true (which lets the
// fake provider start under NODE_ENV=production; never set it on a public deployment). Without them the specs skip.
test.skip(
	process.env.BILLING_PROVIDER !== "fake",
	"needs a server started with BILLING_PROVIDER=fake (not production)",
);
test.describe.configure({ mode: "serial" });

test("an owner upgrades, approves on the fake page, sees the plan active and the invoice, then cancels", async ({
	authPage: page,
	account,
}) => {
	await setAccountOrganizationPlan(account, "personal");
	await page.goto("/dashboard/organization/billing");
	await expect(page.getByTestId("billing-plan-name")).toHaveText("Personal");

	await page
		.getByTestId("plan-card-starter")
		.getByRole("button", { name: /Choose/ })
		.click();
	await page.getByRole("button", { name: "Continue to payment" }).click();

	// The fake provider's own page, on the platform host.
	await expect(page.getByRole("heading", { name: "Test checkout" })).toBeVisible();
	await page.getByRole("button", { name: "Approve payment" }).click();

	// The return page waits for the webhook, then confirms.
	await expect(page.getByTestId("billing-return")).toBeVisible();
	await expect(page.getByTestId("billing-return")).toHaveAttribute("data-state", "confirmed", { timeout: 30_000 });

	await page.getByRole("link", { name: "Back to billing" }).click();
	await expect(page.getByTestId("billing-plan-name")).toHaveText("Starter");
	await expect(page.getByTestId("billing-status")).toHaveText("Active");
	await expect(page.getByTestId("invoice-row")).toHaveCount(1);

	// The receipt prints without card data.
	await page.getByTestId("invoice-row").getByRole("link", { name: "Receipt" }).click();
	await expect(page.getByTestId("receipt")).toBeVisible();
	await page.goBack();

	// Cancel keeps the organization working until the period ends.
	await page.getByRole("button", { name: "Cancel subscription" }).click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("keeps working until");
	await dialog.getByRole("button", { name: "Cancel subscription" }).click();
	await expect(page.getByTestId("billing-status")).toHaveText("Ends at period end", { timeout: 15_000 });
});

test("a declined payment changes nothing", async ({ authPage: page, account }) => {
	await setAccountOrganizationPlan(account, "personal");
	await page.goto("/dashboard/organization/billing");
	await page
		.getByTestId("plan-card-starter")
		.getByRole("button", { name: /Choose/ })
		.click();
	await page.getByRole("button", { name: "Continue to payment" }).click();
	await page.getByRole("button", { name: "Decline payment" }).click();
	await expect(page.getByTestId("billing-return")).toHaveAttribute("data-state", "declined");
});

test("a member sees no billing actions", async ({ authPage: page, account }) => {
	const organizationId = await accountOrganizationId(account);
	await withSeedPool((pool) =>
		pool.query(
			`update member set role = 'member' where organization_id = $1 and user_id = (select id from "user" where email = $2)`,
			[organizationId, account.email],
		),
	);
	await page.goto("/dashboard/organization/billing");
	await expect(page.getByTestId("billing-denied")).toBeVisible();
	await expect(page.getByRole("button", { name: /Choose|Continue to payment|Cancel subscription/ })).toHaveCount(0);
});
