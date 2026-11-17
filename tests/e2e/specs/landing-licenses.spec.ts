import { expect, test } from "@playwright/test";

// CAREEROS: the marketing home page, the organisations page and the public open-source licenses page (P2-T08, P6-M02).
test("the home page markets the product and links to sign-in and registration", async ({ page }) => {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	await page.goto("/");
	await expect(
		page.getByRole("heading", { level: 1, name: "Job search workspace for resumes and applications" }),
	).toBeVisible();
	await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/auth/login");
	await expect(page.getByRole("link", { name: "Try CareerOS", exact: true }).first()).toHaveAttribute(
		"href",
		"/auth/register",
	);
	await expect(page).toHaveTitle("CareerOS: resume builder and job application tracker");
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/$/);
	// The content security policy blocks anything the page should not load; a violation is logged as an error.
	expect(errors).toEqual([]);
});

test("the organisations page has a clean address and its file name redirects to it", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("link", { name: "For organisations", exact: true }).first().click();
	await expect(page).toHaveURL(/\/organisations$/);
	await expect(
		page.getByRole("heading", { level: 1, name: "Career platform for universities and bootcamps" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { level: 3, name: "Enterprise", exact: true })).toBeVisible();

	await page.goto("/site/organisations.html");
	await expect(page).toHaveURL(/\/organisations$/);
	await page.goto("/landing/index.html");
	await expect(page).toHaveURL(/\/$/);
});

test("the sitemap lists the marketing pages", async ({ request }) => {
	const xml = await (await request.get("/sitemaps/pages.xml")).text();
	expect(xml).toMatch(/<loc>[^<]+\/<\/loc>/);
	expect(xml).toMatch(/<loc>[^<]+\/organisations<\/loc>/);
	expect(await (await request.get("/robots.txt")).text()).toContain("/sitemap.xml");
});

test("the licenses page keeps the upstream MIT notice and is linked from the home page footer", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("link", { name: "Open-source licenses" }).click();
	await expect(page).toHaveURL(/\/licenses$/);
	await expect(page.getByRole("heading", { level: 1, name: "Open-source licenses" })).toBeVisible();
	await expect(page.getByText("Copyright (c) 2026 Amruth Pillai")).toBeVisible();
	await expect(page.getByText("Permission is hereby granted, free of charge").first()).toBeVisible();
});
