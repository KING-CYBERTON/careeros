// CAREEROS (P2-C04): fail when an upstream workflow can run on a `v*` tag push in this repository without the
// upstream-only guard. The first CareerOS release tag must start `careeros-image` and nothing else that publishes.
// Workflows are read with a small line-based parser (no YAML dependency): it understands the shapes GitHub
// workflows use for `on:` and for a job's `if:`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_GUARD = "github.repository == 'amruthpillai/reactive-resume'";

// A sample tag name that CareerOS releases use. A tag filter "matches" when it would select this tag.
const SAMPLE_TAG = "v1.2.3";

function stripComment(line) {
	return line.replace(/(^|\s)#.*$/, "").replace(/\s+$/, "");
}

function indentOf(line) {
	return line.length - line.trimStart().length;
}

function unquote(value) {
	return value.trim().replace(/^["']|["']$/g, "");
}

// GitHub filter patterns: `*` matches anything but `/`, `**` matches anything.
export function globMatches(pattern, text) {
	const source = pattern
		.split("**")
		.map((part) => part.split("*").map(escapeRegExp).join("[^/]*"))
		.join(".*");
	return new RegExp(`^${source}$`).test(text);
}

function escapeRegExp(value) {
	return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

// Returns the lines (comments removed, blank lines dropped) of the block that starts at `key` with `indent`.
function blockOf(lines, startIndex) {
	const base = indentOf(lines[startIndex]);
	const block = [];
	for (let i = startIndex + 1; i < lines.length; i++) {
		if (indentOf(lines[i]) <= base) break;
		block.push(lines[i]);
	}
	return block;
}

function listValues(blockLines) {
	return blockLines
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => unquote(line.slice(2)));
}

function inlineList(value) {
	const match = /^\[(.*)\]$/.exec(value.trim());
	if (!match) return null;
	return match[1]
		.split(",")
		.map((item) => unquote(item))
		.filter(Boolean);
}

/**
 * Whether the workflow text runs on a push of a tag named like a release (`v1.2.3`).
 * A `push` trigger with no tag or branch filter runs on every tag. Only `branches` / `branches-ignore` means no tags.
 */
export function runsOnVersionTagPush(text) {
	const lines = text
		.split("\n")
		.map(stripComment)
		.filter((line) => line.trim() !== "");
	const onIndex = lines.findIndex((line) => /^["']?on["']?:/.test(line));
	if (onIndex < 0) return false;

	const scalar = lines[onIndex].replace(/^["']?on["']?:/, "").trim();
	if (scalar) {
		const events = inlineList(scalar) ?? [unquote(scalar)];
		return events.includes("push");
	}

	const block = blockOf(lines, onIndex);
	const pushAt = block.findIndex((line) => /^\s*push:/.test(line));
	if (pushAt < 0) return false;
	const pushLine = block[pushAt];
	const pushIndent = indentOf(pushLine);
	const pushBody = [];
	for (let i = pushAt + 1; i < block.length; i++) {
		if (indentOf(block[i]) <= pushIndent) break;
		pushBody.push(block[i]);
	}
	// `push:` with nothing under it (or `push: {}`) fires for every ref, tags included.
	if (pushBody.length === 0) return true;

	const filters = new Map();
	for (let i = 0; i < pushBody.length; i++) {
		const match = /^\s*(branches|branches-ignore|tags|tags-ignore|paths|paths-ignore):\s*(.*)$/.exec(pushBody[i]);
		if (!match) continue;
		const [, name, rest] = match;
		const values = rest.trim() ? (inlineList(rest) ?? [unquote(rest)]) : listValues(blockOf(pushBody, i));
		filters.set(name, values);
	}
	const tags = filters.get("tags");
	const tagsIgnore = filters.get("tags-ignore");
	if (tags) {
		let matched = false;
		for (const pattern of tags) {
			if (pattern.startsWith("!")) {
				if (globMatches(pattern.slice(1), SAMPLE_TAG)) matched = false;
			} else if (globMatches(pattern, SAMPLE_TAG)) {
				matched = true;
			}
		}
		return matched;
	}
	if (tagsIgnore) return !tagsIgnore.some((pattern) => globMatches(pattern, SAMPLE_TAG));
	// Only a branch filter: tags never match it. No filter at all: every ref, tags included.
	return !(filters.has("branches") || filters.has("branches-ignore"));
}

/** The jobs of a workflow: `{ name, condition }`, where `condition` is the text of the job-level `if:` (or ""). */
export function jobsOf(text) {
	const lines = text
		.split("\n")
		.map(stripComment)
		.filter((line) => line.trim() !== "");
	const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
	if (jobsIndex < 0) return [];
	const block = blockOf(lines, jobsIndex);
	const jobIndent = block.length ? indentOf(block[0]) : 2;
	const jobs = [];
	for (let i = 0; i < block.length; i++) {
		const header = /^(\s*)([A-Za-z0-9_-]+):\s*$/.exec(block[i]);
		if (!header || header[1].length !== jobIndent) continue;
		const body = blockOf(block, i);
		const bodyIndent = body.length ? indentOf(body[0]) : jobIndent + 2;
		let condition = "";
		for (let j = 0; j < body.length; j++) {
			const match = /^(\s*)if:\s*(.*)$/.exec(body[j]);
			if (!match || match[1].length !== bodyIndent) continue;
			const inline = match[2].trim();
			const continuation = [];
			for (let k = j + 1; k < body.length && indentOf(body[k]) > bodyIndent; k++) continuation.push(body[k].trim());
			condition = [/^[>|][+-]?$/.test(inline) ? "" : inline, ...continuation].join(" ").trim();
			break;
		}
		jobs.push({ name: header[2], condition });
	}
	return jobs;
}

/** Problems for one workflow file: every job of a tag-triggered upstream workflow needs the upstream guard. */
export function checkWorkflow(file, text) {
	if (!runsOnVersionTagPush(text)) return [];
	const problems = [];
	for (const job of jobsOf(text)) {
		if (!job.condition.includes(UPSTREAM_GUARD)) {
			problems.push(`${file}: job "${job.name}" can run on a ${SAMPLE_TAG} tag push without \`if: ${UPSTREAM_GUARD}\``);
		}
	}
	return problems;
}

/** Checks every non-`careeros-*` workflow under `root`/.github/workflows. */
export function checkWorkflows(root) {
	const dir = join(root, ".github", "workflows");
	const problems = [];
	const checked = [];
	for (const name of readdirSync(dir).sort()) {
		if (!/\.ya?ml$/.test(name) || name.startsWith("careeros-")) continue;
		checked.push(name);
		problems.push(...checkWorkflow(name, readFileSync(join(dir, name), "utf8")));
	}
	return { problems, checked };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const { problems, checked } = checkWorkflows(root);
	if (problems.length > 0) {
		for (const problem of problems) console.error(problem);
		process.exit(1);
	}
	console.log(`release-guard: ${checked.length} upstream workflows checked, none can publish on a version tag.`);
}
