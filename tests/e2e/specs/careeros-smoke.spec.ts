import { registerViaUi } from "../fixtures/auth";
import { expect, test } from "../fixtures/test";

test("CareerOS smoke: a fresh user signs up through the UI and reaches the dashboard", async ({ page, account }) => {
	await registerViaUi(page, account);
	await expect(page).toHaveURL(/\/dashboard/);
});
