// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
	features: {} as Record<string, boolean>,
	sources: [] as object[],
	runs: [] as object[],
	list: vi.fn(),
	runsList: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	runNow: vi.fn(),
	confirm: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useRouteContext: () => ({ flags: { features: mocks.features } }),
}));
vi.mock("@/hooks/use-confirm", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: mocks.toast, close: vi.fn() } }));
vi.mock("@/libs/orpc/client", () => {
	const query = (name: string, fn: (input: unknown) => unknown) => ({
		key: () => [name],
		queryOptions: (options: { input?: unknown } = {}) => {
			const { input, ...rest } = options;
			return { ...rest, queryKey: [name, input], queryFn: async () => fn(input) };
		},
	});
	const mutation = (name: string, fn: (input: unknown) => unknown) => ({
		key: () => [name],
		mutationOptions: (options: object = {}) => ({ ...options, mutationFn: async (input: unknown) => fn(input) }),
	});
	return {
		orpc: {
			discovery: {
				sources: {
					key: () => ["sources"],
					list: query("sources", () => mocks.list()),
					create: mutation("create", (input) => mocks.create(input)),
					update: mutation("update", (input) => mocks.update(input)),
					delete: mutation("delete", (input) => mocks.remove(input)),
				},
				runs: { key: () => ["runs"], list: query("runs", (input) => mocks.runsList(input)) },
				jobs: { key: () => ["jobs"] },
				runNow: mutation("runNow", (input) => mocks.runNow(input)),
			},
		},
	};
});

i18n.loadAndActivate({ locale: "en", messages: {} });
const { DiscoverySearches } = await import("./searches");

const source = (patch: object = {}) => ({
	id: "s1",
	name: "Product roles",
	titles: ["Product Manager"],
	skills: [],
	keywords: [],
	locations: ["Nairobi"],
	remote: "any",
	boards: [{ source: "greenhouse", token: "acme" }],
	schedule: "daily",
	nextRunAt: new Date("2026-11-09T06:00:00Z"),
	lastRunAt: null,
	lastScheduledRunAt: null,
	aiTopN: 10,
	createdAt: new Date(),
	updatedAt: new Date(),
	...patch,
});
const run = (patch: object = {}) => ({
	runId: "r1",
	jobSourceId: "s1",
	status: "succeeded",
	fetched: 10,
	new: 4,
	duplicate: 0,
	scored: 4,
	aiMatched: 0,
	aiPlanned: 0,
	aiSkippedReason: null,
	errors: [],
	trigger: "manual",
	startedAt: new Date("2026-11-08T06:00:00Z"),
	finishedAt: new Date("2026-11-08T06:01:00Z"),
	...patch,
});

const renderSearches = () =>
	render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<DiscoverySearches />
			</QueryClientProvider>
		</I18nProvider>,
	);

beforeEach(() => {
	mocks.features = { job_discovery: true };
	mocks.sources = [];
	mocks.runs = [];
	mocks.list.mockImplementation(() => mocks.sources);
	mocks.runsList.mockImplementation(() => mocks.runs);
	mocks.create.mockImplementation(async (input: object) => source(input));
	mocks.update.mockImplementation(async (input: object) => source(input));
	mocks.remove.mockResolvedValue(undefined);
	mocks.runNow.mockResolvedValue(run({ runId: "r2", status: "running", new: 0, finishedAt: null }));
	mocks.confirm.mockResolvedValue(true);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("explains what a search does and offers New search when there are none", async () => {
	renderSearches();
	expect(await screen.findByText(/You have no searches yet/)).toBeTruthy();
	expect(screen.getByRole("button", { name: "New search" })).toBeTruthy();
});

it("creates a search with chips and a board pasted as a link, then closes the form", async () => {
	const user = userEvent.setup();
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "New search" }));

	await user.type(screen.getByLabelText("Name"), "Remote PM");
	await user.type(screen.getByLabelText("Job titles"), "Product Manager,Product Owner,product manager,");
	await user.click(screen.getByRole("button", { name: "Add a board" }));
	await user.click(screen.getByLabelText("Board 1 name or link"));
	await user.paste("https://jobs.lever.co/acme/123?source=x");
	expect((screen.getByLabelText("Board 1 source") as HTMLSelectElement).value).toBe("lever");
	expect((screen.getByLabelText("Board 1 name or link") as HTMLInputElement).value).toBe("acme");
	await user.click(screen.getByRole("button", { name: "Create search" }));

	await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
	expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({
		name: "Remote PM",
		titles: ["Product Manager", "Product Owner"],
		boards: [{ source: "lever", token: "acme" }],
		schedule: "daily",
		aiTopN: 10,
	});
	await waitFor(() => expect(screen.queryByRole("form", { name: "New search" })).toBeNull());
});

it("shows a message for a board link from an unsupported host and does not save", async () => {
	const user = userEvent.setup();
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "New search" }));
	await user.type(screen.getByLabelText("Name"), "x");
	await user.click(screen.getByRole("button", { name: "Add a board" }));
	await user.click(screen.getByLabelText("Board 1 name or link"));
	await user.paste("https://www.linkedin.com/jobs/view/1");
	expect(screen.getByText("This board isn't supported yet")).toBeTruthy();
	await user.click(screen.getByRole("button", { name: "Create search" }));
	expect(mocks.create).not.toHaveBeenCalled();
});

it("validates the name and keeps the form, with the typed values, when a save fails", async () => {
	const user = userEvent.setup();
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "New search" }));
	await user.click(screen.getByRole("button", { name: "Create search" }));
	expect(screen.getByText("Give this search a name.")).toBeTruthy();
	expect(mocks.create).not.toHaveBeenCalled();

	mocks.create.mockRejectedValueOnce(
		new ORPCError("BAD_REQUEST", {
			message: "Input validation failed",
			data: { issues: [{ code: "too_big", path: ["name"], message: "too long" }] },
		}),
	);
	await user.type(screen.getByLabelText("Name"), "Keep me");
	await user.click(screen.getByRole("button", { name: "Create search" }));
	expect(await screen.findByText("Use at most 120 characters.")).toBeTruthy();
	expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Keep me");
});

it("shows the limit message when the server refuses a create at the search limit", async () => {
	const user = userEvent.setup();
	mocks.create.mockRejectedValueOnce(
		new ORPCError("BAD_REQUEST", {
			message: "You can have at most 20 automations. Delete one to add another.",
			data: { code: "AUTOMATION_LIMIT_REACHED", limit: 20 },
		}),
	);
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "New search" }));
	await user.type(screen.getByLabelText("Name"), "One more");
	await user.click(screen.getByRole("button", { name: "Create search" }));
	expect(await screen.findByText("You can have at most 20 searches. Delete one to add another.")).toBeTruthy();
	expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("One more");
});

it("edits a saved search through update with its id", async () => {
	const user = userEvent.setup();
	mocks.sources = [source()];
	mocks.runs = [run()];
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "Edit" }));
	const name = screen.getByLabelText("Name") as HTMLInputElement;
	expect(name.value).toBe("Product roles");
	await user.clear(name);
	await user.type(name, "Renamed");
	await user.click(screen.getByRole("button", { name: "Save changes" }));
	await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
	expect(mocks.update.mock.calls[0]?.[0]).toMatchObject({ id: "s1", name: "Renamed", schedule: "daily" });
	expect(mocks.create).not.toHaveBeenCalled();
});

it("lists name, schedule, next run, last run status and the new job count", async () => {
	mocks.sources = [source()];
	mocks.runs = [run({ status: "partial", new: 7 })];
	renderSearches();
	const row = (await screen.findByText("Product roles")).closest("li") as HTMLElement;
	expect(within(row).getByText("Daily")).toBeTruthy();
	expect(await within(row).findByText("Finished with errors")).toBeTruthy();
	expect(within(row).getByText("7")).toBeTruthy();
	expect(within(row).getByText("Next run")).toBeTruthy();
});

it("pauses and resumes with an update of the schedule", async () => {
	const user = userEvent.setup();
	mocks.sources = [source()];
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "Pause" }));
	await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ id: "s1", schedule: "paused" }));
	cleanup();

	mocks.update.mockClear();
	mocks.sources = [source({ schedule: "paused", nextRunAt: null })];
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "Resume" }));
	await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ id: "s1", schedule: "daily" }));
});

it("deletes only after the confirmation says yes", async () => {
	const user = userEvent.setup();
	mocks.sources = [source()];
	mocks.confirm.mockResolvedValueOnce(false);
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "Delete" }));
	expect(mocks.confirm).toHaveBeenCalledTimes(1);
	expect(mocks.remove).not.toHaveBeenCalled();

	mocks.confirm.mockResolvedValueOnce(true);
	await user.click(screen.getByRole("button", { name: "Delete" }));
	await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ id: "s1" }));
});

it("runs now, shows Running, and stops when runs.list shows the run finished", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		mocks.sources = [source()];
		mocks.runs = [run()];
		renderSearches();
		const start = await screen.findByRole("button", { name: "Run now" });
		mocks.runs = [run({ runId: "r2", status: "running", new: 0, finishedAt: null }), run()];
		await user.click(start);
		await waitFor(() => expect(mocks.runNow).toHaveBeenCalledWith({ jobSourceId: "s1" }));
		expect(await screen.findByRole("button", { name: "Running" })).toBeTruthy();
		expect(screen.getAllByText("Running").length).toBeGreaterThan(0);

		mocks.runs = [run({ runId: "r2", status: "succeeded", new: 3 }), run()];
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await screen.findByRole("button", { name: "Run now" })).toBeTruthy();
		expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
	} finally {
		vi.useRealTimers();
	}
});

it("polls every 5 seconds and gives up after 3 minutes", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		mocks.sources = [source()];
		mocks.runs = [run()];
		renderSearches();
		const start = await screen.findByRole("button", { name: "Run now" });
		mocks.runs = [run({ runId: "r2", status: "running", new: 0, finishedAt: null }), run()];
		await user.click(start);
		await screen.findByRole("button", { name: "Running" });

		const before = mocks.runsList.mock.calls.length;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(mocks.runsList.mock.calls.length - before).toBeGreaterThanOrEqual(2);
		expect(mocks.runsList.mock.calls.length - before).toBeLessThanOrEqual(3);

		await vi.advanceTimersByTimeAsync(200_000);
		const settled = mocks.runsList.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.runsList.mock.calls.length).toBe(settled);
	} finally {
		vi.useRealTimers();
	}
});

it("hides the AI field without the platform_ai feature and shows it, with the credit note, with it", async () => {
	const user = userEvent.setup();
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "New search" }));
	expect(screen.queryByLabelText("Jobs to score with AI per run")).toBeNull();
	cleanup();

	mocks.features = { job_discovery: true, platform_ai: true };
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "New search" }));
	expect(screen.getByLabelText("Jobs to score with AI per run")).toBeTruthy();
	expect(screen.getByText(/uses AI credits/)).toBeTruthy();
	await user.type(screen.getByLabelText("Name"), "AI search");
	const ai = screen.getByLabelText("Jobs to score with AI per run");
	await user.clear(ai);
	await user.type(ai, "51");
	await user.click(screen.getByRole("button", { name: "Create search" }));
	expect(screen.getByText("Enter a whole number from 0 to 50.")).toBeTruthy();
	expect(mocks.create).not.toHaveBeenCalled();
});

it("is read-only without the job_discovery feature: a plan note, no create, run or edit", async () => {
	mocks.features = {};
	mocks.list.mockResolvedValue([source()]);
	renderSearches();
	expect(await screen.findByText(/plan doesn't include job discovery/)).toBeTruthy();
	expect(await screen.findByText("Product roles")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "New search" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
});

it("shows only the plan note when the server refuses the list", async () => {
	mocks.features = {};
	mocks.list.mockRejectedValue(new ORPCError("FORBIDDEN", { data: { code: "FEATURE_NOT_IN_PLAN" } }));
	renderSearches();
	expect(await screen.findByText(/plan doesn't include job discovery/)).toBeTruthy();
	expect(screen.queryByRole("button", { name: "New search" })).toBeNull();
	expect(screen.queryByRole("alert")).toBeNull();
});

it("gives each chip field exactly one labelled control, even with chips added", async () => {
	const user = userEvent.setup();
	renderSearches();
	await user.click(await screen.findByRole("button", { name: "New search" }));
	for (const label of ["Job titles", "Skills", "Keywords", "Locations"]) {
		await user.type(screen.getByLabelText(label, { exact: true }), `${label} one,`);
		expect(screen.getAllByLabelText(label, { exact: true })).toHaveLength(1);
	}
});
