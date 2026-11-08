// CAREEROS (P4-T03): how the web and mobile screens follow a run they started. Run now answers as soon as the run is
// recorded as `running`; the screen then asks `runs.list` every 5 seconds, for at most 3 minutes, until that run is no
// longer running. The rules live here so both apps follow a run the same way.

export const RUN_POLL_MS = 5_000;
export const RUN_POLL_MAX_MS = 3 * 60_000;

/** The schedule "Resume" gives back: the server keeps no earlier schedule, so it is the create default. */
export const RESUME_SCHEDULE = "daily" as const;

export type RunStatus = "running" | "succeeded" | "failed" | "partial";
export type RunLike = { runId: string; status: RunStatus; new: number };
export type WatchedRun = { runId: string; until: number };

export type RunView<T extends RunLike> = {
	/** The newest run, if any. */
	latest: T | undefined;
	/** The run being followed, once `runs.list` shows it. */
	followed: T | undefined;
	/** True while the screen should say "Running". */
	running: boolean;
	/** True when the followed run has ended, so the screen can report it and stop following. */
	finished: boolean;
};

export function viewRuns<T extends RunLike>(runs: readonly T[] | undefined, watching: WatchedRun | null): RunView<T> {
	const latest = runs?.[0];
	const followed = watching ? runs?.find((run) => run.runId === watching.runId) : undefined;
	const running = watching ? followed === undefined || followed.status === "running" : latest?.status === "running";
	return { latest, followed, running, finished: !!watching && !!followed && followed.status !== "running" };
}

/**
 * The delay before the next poll, or false when nothing is running or the 3 minutes are up. A run the screen started
 * is followed until `watching.until`; a run already going when the screen opened (a scheduled one) is followed for 3
 * minutes from its own start.
 */
export function pollDelay<T extends RunLike & { startedAt: Date | string }>(
	runs: readonly T[] | undefined,
	watching: WatchedRun | null,
	now: number,
): number | false {
	const view = viewRuns(runs, watching);
	if (!view.running) return false;
	const limit = watching ? watching.until : new Date(view.latest?.startedAt ?? 0).getTime() + RUN_POLL_MAX_MS;
	return now < limit ? RUN_POLL_MS : false;
}

export const startWatching = (runId: string, now = Date.now()): WatchedRun => ({ runId, until: now + RUN_POLL_MAX_MS });
