import { createAuthenticatedContext } from "../fixtures/auth";
import {
	createInviteeAccount,
	deleteE2EOrganizations,
	markEmailVerified,
	setAccountOrganizationPlan,
} from "../fixtures/careeros-org";
import { deleteE2EUser } from "../fixtures/db";
import { expect, test } from "../fixtures/test";

// P5-T04: email templates per stage. A member writes a thank-you from an application and the mail link carries the
// filled subject; an organization admin edits the follow-up default and a member sees it.
const WORKSPACE = "E2E Test User's workspace";

test("a member writes a thank-you from an application and the mail link carries the filled subject", async ({
	authPage: page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const created = await page.request.post("/api/openapi/applications", {
		data: {
			company: "Brightpath",
			role: "Product designer",
			status: "interview",
			contacts: [{ name: "Sam Rivera", type: "Recruiter", email: "sam@brightpath.test" }],
		},
	});
	await expect(created).toBeOK();
	const id = (await created.json()) as string;

	await page.goto(`/dashboard/applications/${id}/messages`);
	await page.getByRole("button", { name: "Write email" }).first().click();

	const sheet = page.getByRole("dialog");
	// An interview-stage application starts on the thank-you template, filled in from the application.
	await expect(sheet.getByLabel("Template", { exact: true })).toContainText("Thank you after an interview");
	await expect(page.getByTestId("write-email-to")).toContainText("sam@brightpath.test");
	await expect(sheet.getByLabel("Message", { exact: true })).toHaveValue(/Hello Sam Rivera,/);
	await expect(sheet.getByLabel("Message", { exact: true })).toHaveValue(/the Product designer role at Brightpath/);

	// The person's own edit to the subject is what the link carries.
	await sheet.getByLabel("Subject", { exact: true }).fill("Thank you, Sam");
	const link = page.getByTestId("write-email-open-mail");
	await expect(link).toHaveAttribute(
		"href",
		/^mailto:sam@brightpath\.test\?subject=Thank%20you%2C%20Sam&body=Hello%20Sam%20Rivera/,
	);
});

test("an organization admin edits the follow-up default and a member sees it", async ({
	authPage: admin,
	account,
	browser,
	playwright,
}, testInfo) => {
	const baseURL = String(testInfo.project.use.baseURL ?? "http://localhost:3000");
	const member = createInviteeAccount(account);
	const memberRequest = await playwright.request.newContext({ baseURL });

	try {
		const memberContext = await createAuthenticatedContext(browser, memberRequest, member, baseURL);
		await markEmailVerified(member);
		// A personal workspace has one seat and no organization defaults, so the owner's workspace gets a plan first.
		await setAccountOrganizationPlan(account, "pro");

		await admin.goto("/dashboard/settings/members");
		await admin.getByLabel("Email address", { exact: true }).fill(member.email);
		await admin.getByRole("button", { name: "Send invitation" }).click();
		await expect(admin.getByTestId("invitation-row").filter({ hasText: member.email })).toBeVisible();
		const response = await admin.request.get("/api/auth/organization/list-invitations");
		expect(response.ok()).toBe(true);
		const invitation = ((await response.json()) as { id: string; email: string }[]).find(
			(item) => item.email === member.email,
		);
		if (!invitation) throw new Error("The invitation was not created.");
		const memberPage = await memberContext.newPage();
		await memberPage.goto(`/auth/accept-invitation/${invitation.id}`);
		await memberPage.getByRole("button", { name: "Accept" }).click();
		await memberPage.waitForURL(/\/dashboard/);
		await memberPage.getByLabel("Organization").selectOption({ label: WORKSPACE });

		// The admin starts from the built-in follow-up text and saves it under the organization's own name.
		await admin.goto("/dashboard/settings/org-email-templates");
		await admin.getByRole("button", { name: "Customise Follow up after applying" }).click();
		await expect(admin.getByLabel("Message")).toHaveValue(/I applied for the/);
		await admin.getByLabel("Name").fill("Our follow-up after applying");
		await admin.getByRole("button", { name: "Save template" }).click();
		await expect(admin.getByText("Our follow-up after applying")).toBeVisible();

		// A member of the organization sees it, as the organization's, without being able to change it.
		await memberPage.goto("/dashboard/settings/email-templates");
		const row = memberPage.getByTestId("email-template-row").filter({ hasText: "Our follow-up after applying" });
		await expect(row).toBeVisible();
		await expect(row).toContainText("Organization");
		await expect(row.getByRole("button", { name: /^(Edit|Archive) / })).toHaveCount(0);
		await expect(memberPage.getByText("Follow up after applying", { exact: true })).toHaveCount(0);

		// Members have no organization console for templates.
		await memberPage.goto("/dashboard/settings/org-email-templates");
		await expect(memberPage.getByTestId("org-admin-denied")).toBeVisible();
	} finally {
		await memberRequest.dispose();
		await deleteE2EOrganizations([account, member]);
		await deleteE2EUser(member);
	}
});
