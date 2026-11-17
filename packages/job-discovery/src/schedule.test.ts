import { describe, expect, it } from "vite-plus/test";
import { JITTER_MAX_MS, nextRunAfter, STALE_RUN_MINUTES } from "./schedule";

const FROM = new Date("2026-11-08T10:00:00.000Z");
const DAY = 24 * 3600_000;

describe("nextRunAfter", () => {
	it("adds 24 hours for daily and 7 days for weekly when the jitter is zero", () => {
		expect(nextRunAfter("daily", FROM, () => 0)?.getTime()).toBe(FROM.getTime() + DAY);
		expect(nextRunAfter("weekly", FROM, () => 0)?.getTime()).toBe(FROM.getTime() + 7 * DAY);
	});

	it("adds up to 30 minutes of jitter and never the full 30", () => {
		const nearlyOne = nextRunAfter("daily", FROM, () => 0.9999999999)?.getTime() ?? 0;
		expect(nearlyOne).toBeLessThan(FROM.getTime() + DAY + JITTER_MAX_MS);
		expect(nearlyOne).toBeGreaterThan(FROM.getTime() + DAY + JITTER_MAX_MS - 1000);
		// A misbehaving random source is clamped into the same bounds.
		expect(nextRunAfter("daily", FROM, () => 5)?.getTime()).toBeLessThan(FROM.getTime() + DAY + JITTER_MAX_MS);
		expect(nextRunAfter("daily", FROM, () => -5)?.getTime()).toBe(FROM.getTime() + DAY);
	});

	it("stays inside the bounds for many random draws", () => {
		for (let i = 0; i < 500; i++) {
			const at = nextRunAfter("weekly", FROM)?.getTime() ?? 0;
			expect(at).toBeGreaterThanOrEqual(FROM.getTime() + 7 * DAY);
			expect(at).toBeLessThan(FROM.getTime() + 7 * DAY + JITTER_MAX_MS);
		}
	});

	it("returns null for paused, which clears the schedule", () => {
		expect(nextRunAfter("paused", FROM)).toBeNull();
	});

	it("does not change its input", () => {
		const before = FROM.getTime();
		nextRunAfter("daily", FROM);
		expect(FROM.getTime()).toBe(before);
	});

	it("keeps the stale-run limit at 15 minutes", () => {
		expect(STALE_RUN_MINUTES).toBe(15);
	});
});
