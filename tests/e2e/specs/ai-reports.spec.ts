// CAREEROS: ai_content_report has row-level security (P1-T08), so read it through the owner role (P1-Q07)
import { createSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";

test("stores a private AI report, exports it, and deletes it only after account confirmation", async ({
	authPage: page,
	browser,
}) => {
	const sent = await page.request.post("/api/openapi/ai/content-reports", {
		data: {
			source: "assistant",
			reason: "dangerous",
			content: "Fictional unsafe generated content",
			note: "Fictional safety test",
		},
	});
	await expect(sent).toBeOK();
	const receipt = await sent.json();
	const exported = await page.request.get("/api/openapi/auth/account/export");
	await expect(exported).toBeOK();
	const data = await exported.json();
	expect(data.aiContentReports).toEqual([
		expect.objectContaining({ id: receipt.id, content: "Fictional unsafe generated content" }),
	]);
	const anonymous = await browser.newContext();
	try {
		expect((await anonymous.request.get("/api/openapi/auth/account/export")).status()).toBe(401);
	} finally {
		await anonymous.close();
	}
	await page.goto("/dashboard/settings/account?deleteAccount=true");
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Delete account", exact: true })).toBeDisabled();
	await dialog.getByRole("button", { name: "Keep account" }).click();
	await expect(dialog).not.toBeVisible();
	await expect(await page.request.get("/api/openapi/auth/account/export")).toBeOK();
	await page.reload();
	await expect(dialog).toBeVisible();
	await dialog.getByRole("textbox").fill("delete");
	await dialog.getByRole("button", { name: "Delete account", exact: true }).click();
	await page.waitForURL("/");
	const pool = createSeedPool(); // CAREEROS: owner-role pool (P1-Q07)
	try {
		const reports = await pool.query("select id from ai_content_report where user_id = $1", [data.user.id]);
		expect(reports.rows).toEqual([]);
	} finally {
		await pool.end();
	}
});
