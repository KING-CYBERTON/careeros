import { accountOrganizationId } from "../fixtures/careeros-org";
import { withSeedPool } from "../fixtures/seed-db";
import { expect, test } from "../fixtures/test";

// P4-T03: a member sets up a job search from the app: create, edit, pause, resume and delete, under Career, Jobs.
// No job board is contacted. The server builds every fetch address from a fixed host, and there is no fixture seam for
// those hosts yet (docs/questions.md Q383), so a run's result is seeded straight into the database to show that a
// search's postings reach the review queue below the section.

test("a member creates, edits, pauses and deletes a job search from the Jobs page", async ({
	authPage: page,
	account,
}) => {
	const organizationId = await accountOrganizationId(account);
	const flagId = `e2e-discovery-flag-${organizationId}`;
	// Organization flags win over the plan, so each state is stated explicitly: the personal plan includes platform AI,
	// and the test must not depend on that. `null` removes the flag and leaves the plan to decide.
	const setFeatures = async (discovery: boolean | null, ai: boolean | null) =>
		withSeedPool(async (pool) => {
			for (const [key, value] of [
				["job_discovery", discovery],
				["platform_ai", ai],
			] as const) {
				const id = `${flagId}-${key}`;
				await pool.query(`delete from feature_flag where id = $1`, [id]);
				if (value !== null)
					await pool.query(`insert into feature_flag (id, organization_id, key, enabled) values ($1, $2, $3, $4)`, [
						id,
						organizationId,
						key,
						value,
					]);
			}
		});

	try {
		await setFeatures(true, false);
		await page.goto("/dashboard/career/jobs");
		await expect(page.getByRole("heading", { name: "Searches", exact: true })).toBeVisible();
		await expect(page.getByText(/You have no searches yet/)).toBeVisible();

		// Create: chips, a board pasted as a link, a weekly schedule.
		await page.getByRole("button", { name: "New search" }).click();
		const form = page.getByRole("form", { name: "New search" });
		await form.getByLabel("Name", { exact: true }).fill("Remote product roles");
		const titles = form.getByLabel("Job titles", { exact: true });
		await titles.fill("Product Manager");
		await titles.press("Enter");
		await titles.fill("product manager");
		await titles.press("Enter");
		await expect(form.getByRole("list", { name: "Added: Job titles" }).getByRole("listitem")).toHaveCount(1);
		await form.getByRole("button", { name: "Add a board" }).click();
		await form.getByLabel("Board 1 name or link").fill("https://www.linkedin.com/jobs/view/1");
		await expect(form.getByText("This board isn't supported yet")).toBeVisible();
		await form.getByLabel("Board 1 name or link").fill("https://jobs.lever.co/acme-e2e/0a1b2c3d");
		await expect(form.getByLabel("Board 1 source")).toHaveValue("lever");
		await expect(form.getByLabel("Board 1 name or link")).toHaveValue("acme-e2e");
		await form.getByLabel("Schedule", { exact: true }).selectOption("weekly");
		// The organization has no platform AI (flag off), so the AI field is not offered.
		await expect(form.getByLabel("Jobs to score with AI per run")).toHaveCount(0);
		await form.getByRole("button", { name: "Create search" }).click();

		const row = page.getByRole("listitem").filter({ hasText: "Remote product roles" });
		await expect(row).toBeVisible();
		await expect(row.getByText("Weekly", { exact: true })).toBeVisible();
		await expect(row.getByText("Not run yet")).toBeVisible();

		const sources = await page.request.get("/api/openapi/discovery/sources");
		await expect(sources).toBeOK();
		const saved = (await sources.json()) as { id: string; boards: unknown; titles: string[] }[];
		expect(saved).toHaveLength(1);
		expect(saved[0]?.boards).toEqual([{ source: "lever", token: "acme-e2e" }]);
		expect(saved[0]?.titles).toEqual(["Product Manager"]);

		// A posting the search found shows in the review queue under the section.
		await withSeedPool(async (pool) => {
			const { rows } = await pool.query<{ user_id: string }>(`select user_id from job_source where id = $1`, [
				saved[0]?.id,
			]);
			await pool.query(
				`insert into discovered_job (id, organization_id, user_id, job_source_id, source, external_id, board_token, title, company, url, local_score)
				 values ($1, $2, $3, $4, 'lever', $1, 'acme-e2e', 'Senior Product Manager', 'Acme E2E', 'https://example.test/acme-e2e', 80)`,
				[`e2e-discovered-${saved[0]?.id}`, organizationId, rows[0]?.user_id, saved[0]?.id],
			);
		});
		await page.reload();
		await expect(page.getByRole("link", { name: "Senior Product Manager" })).toBeVisible();

		// Edit.
		await row.getByRole("button", { name: "Edit" }).click();
		const edit = page.getByRole("form", { name: "Edit search" });
		await expect(edit.getByLabel("Name", { exact: true })).toHaveValue("Remote product roles");
		await edit.getByLabel("Name", { exact: true }).fill("Renamed search");
		await edit.getByRole("button", { name: "Save changes" }).click();
		const renamed = page.getByRole("listitem").filter({ hasText: "Renamed search" });
		await expect(renamed).toBeVisible();

		// Pause and resume.
		await renamed.getByRole("button", { name: "Pause" }).click();
		await expect(renamed.getByText("Paused", { exact: true }).first()).toBeVisible();
		await renamed.getByRole("button", { name: "Resume" }).click();
		await expect(renamed.getByRole("button", { name: "Pause" })).toBeVisible();

		// Delete asks first.
		await renamed.getByRole("button", { name: "Delete" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
		await expect(renamed).toBeVisible();
		await renamed.getByRole("button", { name: "Delete" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
		await expect(page.getByText(/You have no searches yet/)).toBeVisible();
		// The job it found stays in the queue.
		await expect(page.getByRole("link", { name: "Senior Product Manager" })).toBeVisible();

		// With platform AI the field is offered, with the credits note.
		await setFeatures(true, true);
		await page.reload();
		await page.getByRole("button", { name: "New search" }).click();
		const withAi = page.getByRole("form", { name: "New search" });
		await expect(withAi.getByLabel("Jobs to score with AI per run")).toBeVisible();
		await expect(withAi.getByText(/uses AI credits/)).toBeVisible();

		// Without the plan feature the section is read-only.
		await setFeatures(null, null);
		await page.reload();
		await expect(page.getByText(/plan doesn't include job discovery/)).toBeVisible();
		await expect(page.getByRole("button", { name: "New search" })).toHaveCount(0);
	} finally {
		await setFeatures(null, null);
	}
});
