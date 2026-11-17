import { setAccountOrganizationPlan, setPlanSeatLimit } from "../fixtures/careeros-org";
import { expect, test } from "../fixtures/test";

// P3-T08: an admin bulk-invites three people from a CSV file; one is over the seat limit.
// The Starter plan's seat limit is lowered for the test and restored afterwards, so the spec runs serially.
test.describe.configure({ mode: "serial" });

test("an admin checks a CSV, sees who fits the seat limit, confirms, and two invitations are sent", async ({
	authPage: page,
	account,
}) => {
	let previousLimit: number | null = null;
	try {
		// The owner holds one seat, so a limit of 3 leaves two for the three addresses in the file.
		previousLimit = await setPlanSeatLimit("starter", 3);
		await setAccountOrganizationPlan(account, "starter");

		const emails = ["one", "two", "three"].map((name) => `bulk-${name}-${account.username}@example.test`);
		const csv = ["email,role", ...emails.map((email) => `${email},member`)].join("\n");

		await page.goto("/dashboard/settings/members");
		await expect(page.getByRole("heading", { name: "Invite from a CSV file" })).toBeVisible();

		await page.getByLabel("CSV file").setInputFiles({
			name: "invites.csv",
			mimeType: "text/csv",
			buffer: Buffer.from(csv),
		});
		await page.getByRole("button", { name: "Check file" }).click();

		// The dry run shows every row and sends nothing.
		const rows = page.getByTestId("bulk-invite-rows").locator("tbody tr");
		await expect(rows).toHaveCount(3);
		await expect(page.getByTestId("bulk-invite-summary")).toContainText("2 of 3 rows can be invited");
		await expect(page.getByTestId("bulk-invite-rows").getByText("No seat left")).toHaveCount(1);
		await expect(page.getByTestId("invitation-row")).toHaveCount(0);

		await page.getByRole("button", { name: "Send 2 invitations" }).click();
		await expect(page.getByTestId("bulk-invite-summary")).toContainText("Sent 2 invitations");
		await expect(page.getByTestId("invitation-row")).toHaveCount(2);
		await expect(page.getByTestId("invitation-row").filter({ hasText: emails[0] ?? "" })).toBeVisible();
		await expect(page.getByTestId("invitation-row").filter({ hasText: emails[1] ?? "" })).toBeVisible();
		await expect(page.getByTestId("invitation-row").filter({ hasText: emails[2] ?? "" })).toHaveCount(0);
	} finally {
		if (previousLimit !== null) await setPlanSeatLimit("starter", previousLimit);
		await setAccountOrganizationPlan(account, "personal");
	}
});

test("a personal workspace has no admin area", async ({ authPage: page }) => {
	await page.goto("/dashboard/settings/cohorts");
	await expect(page.getByTestId("org-admin-denied")).toBeVisible();
});
