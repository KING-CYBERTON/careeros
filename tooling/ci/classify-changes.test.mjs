// CAREEROS: P1-C05. Docs-only path rule used by the `changes` job in careeros-ci.yml.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const script = fileURLToPath(new URL("./classify-changes.sh", import.meta.url));

function classify(paths) {
	const result = spawnSync("bash", [script], { input: paths.join("\n"), encoding: "utf8" });
	expect(result.status).toBe(0);
	return result.stdout.trim();
}

describe("classify-changes", () => {
	it.each([
		[["docs/plans/P1-C05-ci-speed.md"]],
		[["docs/questions.md", "docs/UPSTREAM_PATCHES.md", "docs/images/screenshot.png"]],
		[["README.md", "CLAUDE.md", "PRODUCT.md"]],
		[["notes/anything.md"]],
		[[".github/ISSUE_TEMPLATE/bug.yml"]],
		[["LICENSE", "LICENSE.md"]],
		[["docs/a.md", "README.md", "LICENSE"]],
	])("reports code=false for docs-only %j", (paths) => {
		expect(classify(paths)).toBe("code=false");
	});

	it.each([
		[["apps/web/src/main.tsx"]],
		[["packages/api/README.md"]],
		[["apps/server/README.md"]],
		[["packages/mcp/src/fixtures/tool-annotations.md"]],
		[["plugins/reactive-resume/skills/resume/SKILL.md"]],
		[["tooling/ci/README.md"]],
		[["docs/applying-custom-styles.mdx"]],
		[[".github/workflows/careeros-ci.yml"]],
		[[".github/PULL_REQUEST_TEMPLATE.md"]],
		[["package.json"]],
		[["pnpm-lock.yaml"]],
		[["turbo.json"]],
		[["migrations/0001_init.sql"]],
		[["docs/a.md", "packages/db/src/index.ts"]],
		[["README.md", "docs/a.md", "tests/e2e/specs/auth.spec.ts"]],
		[["docsx/file.md.ts"]],
		[["LICENSEfile.ts"]],
		[["src/not-docs/docs/a.ts"]],
	])("reports code=true when any path is code %j", (paths) => {
		expect(classify(paths)).toBe("code=true");
	});

	it("reports code=true for an empty list", () => {
		expect(classify([])).toBe("code=true");
		expect(classify([""])).toBe("code=true");
	});

	it("handles a last line without a trailing newline and paths with spaces", () => {
		expect(classify(["docs/my notes.md"])).toBe("code=false");
		expect(classify(["docs/a.md", "apps/web/my file.ts"])).toBe("code=true");
	});
});
