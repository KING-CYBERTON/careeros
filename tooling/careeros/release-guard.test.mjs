import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	checkWorkflow,
	checkWorkflows,
	globMatches,
	jobsOf,
	runsOnVersionTagPush,
	UPSTREAM_GUARD,
} from "./release-guard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const tagWorkflow = (jobs) => `name: x
on:
  workflow_dispatch:
  push:
    branches:
      - main
    tags:
      - "v*"

jobs:
${jobs}`;

test("globMatches follows GitHub filter patterns", () => {
	assert.equal(globMatches("v*", "v1.2.3"), true);
	assert.equal(globMatches("v[0-9]*", "v1.2.3"), false); // character classes are not translated; documented limit
	assert.equal(globMatches("v**", "v1/2"), true);
	assert.equal(globMatches("v*", "v1/2"), false);
	assert.equal(globMatches("release-*", "v1.2.3"), false);
});

test("detects tag triggers", () => {
	assert.equal(runsOnVersionTagPush(tagWorkflow("  a:\n    runs-on: x\n")), true);
	assert.equal(runsOnVersionTagPush("on:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: x\n"), false);
	assert.equal(runsOnVersionTagPush("on:\n  push:\n    branches-ignore: [main]\njobs:\n  a:\n    runs-on: x\n"), false);
	assert.equal(runsOnVersionTagPush("on:\n  push:\njobs:\n  a:\n    runs-on: x\n"), true);
	assert.equal(runsOnVersionTagPush("on: push\njobs:\n  a:\n    runs-on: x\n"), true);
	assert.equal(runsOnVersionTagPush("on: [pull_request, push]\njobs:\n  a:\n    runs-on: x\n"), true);
	assert.equal(runsOnVersionTagPush("on:\n  push:\n    tags: ['v*']\njobs:\n  a:\n    runs-on: x\n"), true);
	assert.equal(
		runsOnVersionTagPush("on:\n  push:\n    tags: [v*]\n    tags-ignore: [x]\njobs:\n  a:\n    runs-on: x\n"),
		true,
	);
	assert.equal(
		runsOnVersionTagPush("on:\n  push:\n    tags-ignore:\n      - 'v*'\njobs:\n  a:\n    runs-on: x\n"),
		false,
	);
	assert.equal(
		runsOnVersionTagPush("on:\n  workflow_dispatch:\n  pull_request:\njobs:\n  a:\n    runs-on: x\n"),
		false,
	);
	assert.equal(runsOnVersionTagPush("on:\n  push:\n    tags:\n      - 'api-*'\njobs:\n  a:\n    runs-on: x\n"), false);
});

test("branch-only push filter with a hash comment does not count as a tag trigger", () => {
	assert.equal(
		runsOnVersionTagPush('on:\n  push:\n    branches: ["main"] # nightly\njobs:\n  a:\n    runs-on: x\n'),
		false,
	);
});

test("reads job-level if in inline, folded and absent forms", () => {
	const jobs = jobsOf(
		tagWorkflow(
			[
				"  plan:",
				"    runs-on: x",
				`    if: \${{ ${UPSTREAM_GUARD} }}`,
				"  build:",
				"    needs: plan",
				"    if: >-",
				`      ${UPSTREAM_GUARD} &&`,
				"      needs.plan.result == 'success'",
				"    steps:",
				"      - if: always()",
				"        run: echo",
				"  free:",
				"    runs-on: x",
				"",
			].join("\n"),
		),
	);
	assert.deepEqual(
		jobs.map((job) => [job.name, job.condition.includes(UPSTREAM_GUARD)]),
		[
			["plan", true],
			["build", true],
			["free", false],
		],
	);
});

test("fails for an unguarded job on a tag-triggered workflow, passes when every job is guarded", () => {
	const unguarded = tagWorkflow(`  plan:\n    runs-on: x\n  publish:\n    if: \${{ ${UPSTREAM_GUARD} }}\n`);
	const problems = checkWorkflow("docker-publish.yml", unguarded);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /job "plan"/);

	const guarded = tagWorkflow(
		`  plan:\n    if: ${UPSTREAM_GUARD}\n  publish:\n    if: \${{ !cancelled() && ${UPSTREAM_GUARD} }}\n`,
	);
	assert.deepEqual(checkWorkflow("docker-publish.yml", guarded), []);
});

test("a step-level guard does not count", () => {
	const stepOnly = tagWorkflow(
		`  plan:\n    runs-on: x\n    steps:\n      - if: ${UPSTREAM_GUARD}\n        run: echo\n`,
	);
	assert.equal(checkWorkflow("x.yml", stepOnly).length, 1);
});

test("workflows that cannot run on a tag are not checked", () => {
	assert.deepEqual(
		checkWorkflow("ci.yml", "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  t:\n    runs-on: x\n"),
		[],
	);
});

test("every upstream workflow in this repository is safe on a v* tag push", () => {
	const { problems, checked } = checkWorkflows(root);
	assert.ok(checked.includes("docker-publish.yml"), "docker-publish.yml must be among the checked workflows");
	assert.ok(!checked.some((name) => name.startsWith("careeros-")));
	assert.deepEqual(problems, []);
});
