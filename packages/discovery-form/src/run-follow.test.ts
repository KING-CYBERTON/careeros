import { describe, expect, it } from "vite-plus/test";
import { pollDelay, RUN_POLL_MAX_MS, RUN_POLL_MS, startWatching, viewRuns } from "./run-follow";

const run = (patch: object = {}) => ({
	runId: "r1",
	status: "succeeded" as const,
	new: 1,
	startedAt: new Date("2026-11-08T06:00:00Z"),
	...patch,
});
const NOW = new Date("2026-11-08T06:01:00Z").getTime();

describe("viewRuns", () => {
	it("says Running for a followed run until runs.list shows it finished", () => {
		const watching = startWatching("r2", NOW);
		expect(viewRuns([run()], watching)).toMatchObject({ running: true, finished: false });
		expect(viewRuns([run({ runId: "r2", status: "running" }), run()], watching)).toMatchObject({
			running: true,
			finished: false,
		});
		expect(viewRuns([run({ runId: "r2", new: 3 }), run()], watching)).toMatchObject({ running: false, finished: true });
	});

	it("reads an unfollowed screen from the newest run", () => {
		expect(viewRuns([run({ status: "running" })], null).running).toBe(true);
		expect(viewRuns([run()], null).running).toBe(false);
		expect(viewRuns(undefined, null).running).toBe(false);
	});
});

describe("pollDelay", () => {
	it("polls every 5 seconds while a followed run is going, for at most 3 minutes", () => {
		const watching = startWatching("r2", NOW);
		const going = [run({ runId: "r2", status: "running" })];
		expect(pollDelay(going, watching, NOW + 1_000)).toBe(RUN_POLL_MS);
		expect(pollDelay(going, watching, NOW + RUN_POLL_MAX_MS - 1)).toBe(RUN_POLL_MS);
		expect(pollDelay(going, watching, NOW + RUN_POLL_MAX_MS)).toBe(false);
	});

	it("stops as soon as the followed run has finished", () => {
		expect(pollDelay([run({ runId: "r2" })], startWatching("r2", NOW), NOW + 1_000)).toBe(false);
	});

	it("follows a run that was already going for 3 minutes from its own start", () => {
		const going = [run({ status: "running" })];
		const started = new Date("2026-11-08T06:00:00Z").getTime();
		expect(pollDelay(going, null, started + 60_000)).toBe(RUN_POLL_MS);
		expect(pollDelay(going, null, started + RUN_POLL_MAX_MS + 1)).toBe(false);
		expect(pollDelay([run()], null, started + 60_000)).toBe(false);
		expect(pollDelay(undefined, null, started)).toBe(false);
	});
});
