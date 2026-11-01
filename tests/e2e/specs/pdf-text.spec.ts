import { execFileSync } from "node:child_process";
import { expect, test } from "../fixtures/test";

test("browser PDF downloads preserve shaped scripts and name unsupported text without blocking", async ({
	authPage: page,
}, testInfo) => {
	test.setTimeout(180_000);
	// Chromium's direct CDN connections can fail on CI; still fetch and render the real font bytes.
	// CAREEROS: teardown-safe handler. A fetch still in flight when the test ends rejects with "Request context
	// disposed"; that is ignored. Real failures are recorded and asserted from the test body, never in the handler.
	const fontRouteFailures: string[] = [];
	await page.route(/^https:\/\/fonts\.gstatic\.(?:com|cn)\//, async (route) => {
		try {
			const fontResponse = await route.fetch();
			if (!fontResponse.ok()) {
				fontRouteFailures.push(`${route.request().url()} responded ${fontResponse.status()}`);
				await route.abort();
				return;
			}
			await route.fulfill({ response: fontResponse });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/disposed|closed/i.test(message)) return;
			fontRouteFailures.push(`${route.request().url()} failed: ${message}`);
			await route.abort().catch(() => undefined);
		}
	});
	const created = await page.request.post("/api/openapi/resumes", {
		data: { name: `PDF ${testInfo.testId}`, tags: [] },
	});
	expect(created.ok()).toBe(true);
	const id = (await created.json()) as string;
	const response = await page.request.get(`/api/openapi/resumes/${id}`);
	expect(response.ok()).toBe(true);
	const { data } = await response.json();
	data.picture.hidden = true;
	data.metadata.layout.pages = [{ fullWidth: true, main: ["summary"], sidebar: [] }];
	for (const [text, font, locale] of [
		["שלום עולם ניסיון עבודה", "Noto Sans Hebrew", "he-IL"],
		["مرحبا بالعالم مهندس برمجيات", "Noto Sans Arabic", "ar-SA"],
		["नमस्ते दुनिया अनुभव कौशल", "Noto Sans Devanagari", "hi-IN"],
		["Hello 💻 engineer 🚀 coding 😀", "Noto Sans", "en-US"],
	] as const) {
		data.summary.content = `<p>${text}</p>`;
		data.metadata.page.locale = locale;
		data.metadata.typography.body.fontFamily = font;
		data.metadata.typography.heading.fontFamily = font;
		const updated = await page.request.put(`/api/openapi/resumes/${id}`, { data: { data } });
		expect(updated.ok()).toBe(true);
		await page.goto(`/builder/${id}`);
		const downloaded = page.waitForEvent("download");
		await page.getByRole("button", { name: "Download PDF", exact: true }).click();
		const download = await downloaded;
		expect(await download.failure()).toBeNull();
		const path = await download.path();
		if (!path) throw new Error("Browser did not save the PDF");
		// Read logical text, including /ActualText for shaped clusters, from the browser's downloaded file.
		const extracted = execFileSync("pdftotext", ["-enc", "UTF-8", path, "-"], { encoding: "utf8" });
		expect(extracted.replace(/[\u202A-\u202E]/g, "").replace(/\s+/g, " ")).toContain(text);
	}
	data.summary.content = "<p>Unsupported \u{10FFFF}</p>";
	expect((await page.request.put(`/api/openapi/resumes/${id}`, { data: { data } })).ok()).toBe(true);
	await page.goto(`/builder/${id}`);
	// A character no font can draw prints as "?": the preview renders and names it, and the download still saves.
	const textLoss = page.getByText(/can't display .*\(U\+10FFFF\)/);
	await expect(textLoss).toHaveCount(1);
	const lossyDownload = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download PDF", exact: true }).click();
	expect(await (await lossyDownload).failure()).toBeNull();
	await expect(textLoss).toHaveCount(2);
	const exported = await page.request.get(`/api/openapi/resumes/${id}/pdf`);
	expect(exported.status()).toBe(200);
	expect(exported.headers()["content-type"]).toContain("application/pdf");
	// CAREEROS: stop in-flight font handlers so they cannot fail after the test body, then check what they recorded.
	await page.unrouteAll({ behavior: "ignoreErrors" });
	expect(fontRouteFailures).toEqual([]);
});
