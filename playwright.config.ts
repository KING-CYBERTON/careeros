import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const baseURL = process.env.APP_URL ?? `http://localhost:${port}`;
const isCI = process.env.CI === "true" || process.env.CI === "1";
// CAREEROS: P1-C05. CI worker count comes from PLAYWRIGHT_WORKERS (default 1); an invalid value falls back to 1.
const requestedWorkers = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? "", 10);
const ciWorkers = Number.isInteger(requestedWorkers) && requestedWorkers >= 1 ? requestedWorkers : 1;

// CAREEROS: P2-Q02. The e2e server has no SMTP, so it logs each email it would send (recipient and subject). The
// server's output is copied to this file as well, and the specs read it (fixtures/server-log.ts). Set before the
// config is returned, so the test workers inherit it.
process.env.E2E_SERVER_LOG ??= join(tmpdir(), "careeros-e2e-server.log");

export default defineConfig({
	testDir: "./tests/e2e/specs",
	fullyParallel: true,
	forbidOnly: isCI,
	retries: 0,
	workers: isCI ? ciWorkers : undefined, // CAREEROS: P1-C05 (was `isCI ? 1 : undefined`)
	timeout: 30_000,
	expect: {
		timeout: 10_000,
	},
	reporter: isCI
		? [["list"], ["github"], ["junit", { outputFile: "test-results/e2e-junit.xml" }]]
		: [["list"], ["html", { open: "never" }]],
	use: {
		baseURL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		// Run node directly: pnpm >=12.6 moves script children into their own process group,
		// so Playwright's group kill misses the server and the job hangs after the tests finish.
		// CAREEROS: P2-Q02. `2>&1 | tee` keeps the output in the runner's log and in E2E_SERVER_LOG; the pipeline stays in the
		// shell's process group, so the group kill below still ends the server.
		command: `node apps/server/dist/index.mjs 2>&1 | tee "${process.env.E2E_SERVER_LOG}"`,
		url: `${baseURL}/api/health`,
		reuseExistingServer: !isCI,
		timeout: 120_000,
		env: {
			...process.env,
			APP_URL: baseURL,
			NODE_ENV: "production",
			PORT: String(port),
		},
	},
});
