import { expect, test } from "@playwright/test";

// CAREEROS: the neutral landing page and the public open-source licenses page (P2-T08).
test("the landing page shows the platform name, one line of copy and the sign-in buttons", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { level: 1, name: "CareerOS" })).toBeVisible();
	await expect(page.getByText("Your career workspace", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/auth/login");
	await expect(page.getByRole("link", { name: "Create account", exact: true })).toHaveAttribute(
		"href",
		"/auth/register",
	);
	await expect(page).toHaveTitle("Your career workspace | CareerOS");
});

test("the licenses page keeps the upstream MIT notice and is linked from the landing footer", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("link", { name: "Open-source licenses" }).click();
	await expect(page).toHaveURL(/\/licenses$/);
	await expect(page.getByRole("heading", { level: 1, name: "Open-source licenses" })).toBeVisible();
	await expect(page.getByText("Copyright (c) 2026 Amruth Pillai")).toBeVisible();
	await expect(page.getByText("Permission is hereby granted, free of charge").first()).toBeVisible();
});
