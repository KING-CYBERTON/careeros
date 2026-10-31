import { createAuthenticatedContext } from "../fixtures/auth";
import { createInviteeAccount, deleteE2EOrganizations, markEmailVerified } from "../fixtures/careeros-org";
import { deleteE2EUser } from "../fixtures/db";
import { expect, test } from "../fixtures/test";

// P1-T03: personal workspace at signup, invitations, the organization switcher and member removal.
const PERSONAL_WORKSPACE = "E2E Test User's workspace";

test("an owner invites a user, who accepts and sees both organizations, and the owner removes them", async ({
	authPage: owner,
	account,
	browser,
	playwright,
}, testInfo) => {
	const baseURL = String(testInfo.project.use.baseURL ?? "http://localhost:3000");
	const invitee = createInviteeAccount(account);
	const inviteeRequest = await playwright.request.newContext({ baseURL });

	try {
		// The invitee signs up on their own, so they start with a personal workspace.
		const inviteeContext = await createAuthenticatedContext(browser, inviteeRequest, invitee, baseURL);
		await markEmailVerified(invitee);

		await owner.goto("/dashboard/settings/members");
		await expect(owner.getByRole("heading", { name: "Members & invites" })).toBeVisible();
		await owner.getByLabel("Email address", { exact: true }).fill(invitee.email);
		await owner.getByRole("button", { name: "Send invitation" }).click();
		await expect(owner.getByTestId("invitation-row").filter({ hasText: invitee.email })).toBeVisible();

		// The email goes nowhere in the test environment, so read the invitation id from the API instead.
		const response = await owner.request.get("/api/auth/organization/list-invitations");
		expect(response.ok()).toBe(true);
		const invitations = (await response.json()) as { id: string; email: string }[];
		const invitation = invitations.find((item) => item.email === invitee.email);
		if (!invitation) throw new Error("The invitation was not created.");

		const page = await inviteeContext.newPage();
		await page.goto(`/auth/accept-invitation/${invitation.id}`);
		await expect(page.getByRole("heading", { name: `Join ${PERSONAL_WORKSPACE}` })).toBeVisible();
		await page.getByRole("button", { name: "Accept" }).click();
		await page.waitForURL(/\/dashboard/);

		// Two organizations now, so the switcher appears and lists the owner's.
		const switcher = page.getByLabel("Organization");
		await expect(switcher).toBeVisible();
		await expect(switcher.locator("option", { hasText: PERSONAL_WORKSPACE })).toHaveCount(1);
		await expect(switcher.locator("option", { hasText: "Invitee User's workspace" })).toHaveCount(1);
		await expect(switcher.locator("option:checked")).toHaveText(PERSONAL_WORKSPACE);

		// An invitee is a plain member: no Members & invites entry.
		await page.goto("/dashboard/settings/members");
		await expect(page.getByText("Only owners and admins can manage members")).toBeVisible();

		// The owner sees the new member and removes them.
		await owner.reload();
		const row = owner.getByTestId("member-row").filter({ hasText: invitee.email });
		await expect(row).toBeVisible();
		await expect(owner.getByTestId("invitation-row")).toHaveCount(0);
		await row.getByRole("button", { name: /^Remove/ }).click();
		await owner.getByRole("alertdialog").getByRole("button", { name: "Remove member" }).click();
		await expect(row).toBeHidden();

		// Back to one organization for the invitee.
		await page.goto("/dashboard");
		await expect(page.getByLabel("Organization")).toBeHidden();
	} finally {
		await inviteeRequest.dispose();
		await deleteE2EOrganizations([account, invitee]);
		await deleteE2EUser(invitee);
	}
});

test("shows an error for an invitation that does not exist", async ({ authPage: page }) => {
	await page.goto("/auth/accept-invitation/does-not-exist");
	await expect(page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
});
