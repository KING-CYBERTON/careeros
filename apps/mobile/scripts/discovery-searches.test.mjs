// Run: node --test apps/mobile/scripts/discovery-searches.test.mjs
// CAREEROS (P4-T03): the mobile job search form and the Searches section. The screens under test and the shared
// `@careeros/discovery-form` package are loaded for real; React, the UI kit, the API client and the session are
// fixtures. No network, no real job board.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serverRequire = createRequire(new URL("../../server/package.json", import.meta.url));
const { transformSync } = createRequire(serverRequire.resolve("tsx"))("esbuild");
const z = serverRequire("zod");

const tag = (parts, ...values) => parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");

// A small renderer: every mounted component keeps its own hook state; effects run after each render when their
// dependencies change.
let current;
const react = {
	createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
	useState(initial) {
		const instance = current;
		const i = instance.cursor++;
		if (!(i in instance.hooks)) instance.hooks[i] = typeof initial === "function" ? initial() : initial;
		return [
			instance.hooks[i],
			(value) => {
				const next = typeof value === "function" ? value(instance.hooks[i]) : value;
				if (!Object.is(next, instance.hooks[i])) instance.dirty = true;
				instance.hooks[i] = next;
			},
		];
	},
	useRef(initial) {
		const instance = current;
		const i = instance.cursor++;
		if (!(i in instance.hooks)) instance.hooks[i] = { current: initial };
		return instance.hooks[i];
	},
	useEffect(effect, deps) {
		const instance = current;
		const i = instance.cursor++;
		const previous = instance.hooks[i];
		if (!previous || !deps || deps.some((dep, at) => !Object.is(dep, previous.deps[at]))) {
			previous?.cleanup?.();
			instance.pending.push(() => {
				instance.hooks[i] = { deps, cleanup: effect() };
			});
			instance.hooks[i] = { deps: previous?.deps ?? [], cleanup: previous?.cleanup };
		}
	},
};
function mount(type, props) {
	const instance = { hooks: [], cursor: 0, pending: [], dirty: false };
	const render = (nextProps = props) => {
		let tree;
		for (let pass = 0; pass < 6; pass++) {
			current = instance;
			instance.cursor = 0;
			instance.dirty = false;
			tree = type(nextProps);
			const effects = instance.pending.splice(0);
			for (const effect of effects) effect();
			if (!instance.dirty && effects.length === 0) break;
		}
		return tree;
	};
	return { render, instance };
}
const nodes = (tree) =>
	!tree || typeof tree !== "object"
		? []
		: Array.isArray(tree)
			? tree.flatMap(nodes)
			: [tree, ...nodes(tree.props?.children)];

const cache = new Map();
function load(url, dependencies) {
	const path = fileURLToPath(url);
	if (cache.has(path)) return cache.get(path).exports;
	const module = { exports: {} };
	cache.set(path, module);
	const code = transformSync(readFileSync(path, "utf8"), {
		loader: path.endsWith(".tsx") ? "tsx" : "ts",
		format: "cjs",
		jsx: "transform",
		target: "es2022",
	}).code;
	const timers = dependencies.timers;
	new Function("React", "require", "module", "exports", "setTimeout", "clearTimeout", code)(
		react,
		(name) => {
			if (name.startsWith(".")) {
				const base = dirname(path);
				const candidates = [`${base}/${name}.ts`, `${base}/${name}.tsx`];
				const found = candidates.find((candidate) => {
					try {
						readFileSync(candidate);
						return true;
					} catch {
						return false;
					}
				});
				if (found && !(name in dependencies)) return load(new URL(`file://${found}`), dependencies);
			}
			assert.ok(name in dependencies, `Unexpected boundary: ${name}`);
			return dependencies[name];
		},
		module,
		module.exports,
		timers.set,
		timers.clear,
	);
	return module.exports;
}

const formUrl = (file) => new URL(`../src/features/discovery/${file}`, import.meta.url);

function setup({ features = { job_discovery: true }, sources = [], runs = [], entitlementsPending = false } = {}) {
	cache.clear();
	const calls = { create: [], update: [], remove: [], runNow: [], toasts: [], invalidated: [], intervals: [] };
	const state = { sources, runs, features, entitlementsPending, fail: undefined };
	const timers = { list: [], set: (fn, ms) => timers.list.push({ fn, ms }), clear() {} };
	const reject = (call) => {
		const error = state.fail;
		state.fail = undefined;
		if (error) throw error;
		return call;
	};
	const sourceOf = (input) => ({ id: "s9", ...input });
	const dependencies = {
		timers,
		react,
		"react-native": { View: "View" },
		"@lingui/core/macro": { t: tag },
		"@lingui/react/macro": {
			useLingui: () => ({ t: tag, i18n: { date: (value) => `D:${new Date(value).toISOString().slice(0, 10)}` } }),
		},
		"@tanstack/react-query": {
			useQuery: (options) => {
				const name = options.queryKey[1] === "srv" && options.queryKey.length === 3 ? "runs" : options.queryKey[0];
				if (options.refetchInterval) calls.intervals.push(options.refetchInterval({ state: { data: state.runs } }));
				return name === "runs"
					? { data: state.runs, isPending: false, isError: false, refetch: async () => {} }
					: { data: state.sources, isPending: false, isError: false, refetch: async () => {} };
			},
			useQueryClient: () => ({ invalidateQueries: (arg) => calls.invalidated.push(arg.queryKey[0]) }),
		},
		"@/api/client": {
			client: {
				discovery: {
					sources: {
						create: async (input) => (calls.create.push(input), reject(sourceOf(input))),
						update: async (input) => (calls.update.push(input), reject(sourceOf(input))),
						delete: async (input) => (calls.remove.push(input), reject(undefined)),
					},
					runNow: async (input) => (calls.runNow.push(input), reject({ runId: "r2", status: "running", new: 0 })),
				},
			},
			orpc: {
				discovery: {
					sources: { key: () => ["sources"], list: { queryOptions: () => ({}) } },
					runs: { key: () => ["runs"], list: { queryOptions: () => ({}) } },
					jobs: { key: () => ["jobs"] },
				},
			},
		},
		"@/auth/session": { useSession: () => ({ status: "signed-in", server: "srv" }) },
		"@/features/organization/entitlement-message": { entitlementErrorMessage: () => undefined },
		"@/features/organization/entitlements": {
			useEntitlements: () => ({
				isPending: state.entitlementsPending,
				data: state.entitlementsPending ? undefined : { features: state.features },
			}),
		},
		"@careeros/discovery-form": load(new URL("../../../packages/discovery-form/src/index.ts", import.meta.url), {
			zod: z,
			timers,
		}),
		"@/ui": {
			...Object.fromEntries(
				[
					"Banner",
					"Button",
					"Card",
					"Chip",
					"ConfirmDialog",
					"EmptyState",
					"SelectSheet",
					"Skeleton",
					"Text",
					"TextField",
				].map((name) => [name, name]),
			),
			showToast: (options) => calls.toasts.push(options.message),
			useTheme: () => ({ space: { s0: 2, s1: 4, s2: 8, s3: 12, s4: 16, s12: 48 } }),
		},
		"./messages": undefined,
		"./term-field": { TermField: "TermField" },
		"./search-form": undefined,
	};
	delete dependencies["./messages"];
	delete dependencies["./search-form"];
	const form = load(formUrl("search-form.tsx"), dependencies);
	// The section is loaded with the form stubbed so its own tree can be read.
	const sectionDependencies = { ...dependencies, "./search-form": { SearchForm: "SearchForm" } };
	cache.delete(fileURLToPath(formUrl("searches.tsx")));
	const section = load(formUrl("searches.tsx"), sectionDependencies);
	return { calls, state, timers, form, section };
}

const source = (patch = {}) => ({
	id: "s1",
	name: "Product roles",
	titles: ["Product Manager"],
	skills: [],
	keywords: [],
	locations: ["Nairobi"],
	remote: "any",
	boards: [{ source: "greenhouse", token: "acme" }],
	schedule: "daily",
	nextRunAt: "2026-11-09T06:00:00Z",
	aiTopN: 10,
	...patch,
});
const run = (patch = {}) => ({
	runId: "r1",
	status: "succeeded",
	new: 4,
	startedAt: "2026-11-08T06:00:00Z",
	finishedAt: "2026-11-08T06:01:00Z",
	...patch,
});

const control = (tree, label) => nodes(tree).find((node) => node.props?.label === label)?.props;
const text = (tree) =>
	nodes(tree)
		.filter((node) => node.type === "Text" || node.type === "Banner")
		.flatMap((node) => [node.props.message, ...(node.props.children ?? [])])
		.filter((value) => typeof value === "string");
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("create: chips, a pasted board link, and the payload the server schema accepts", async () => {
	const { form, calls } = setup();
	let closed = 0;
	const screen = mount(form.SearchForm, { showAi: false, onClose: () => closed++ });
	let tree = screen.render();
	assert.equal(control(tree, "Jobs to score with AI per run"), undefined, "AI field is hidden without platform_ai");

	control(tree, "Name").onChangeText("Remote PM");
	tree = screen.render();
	control(tree, "Job titles").onChange(["Product Manager", "Product Owner"]);
	tree = screen.render();
	control(tree, "Add a board").onPress();
	tree = screen.render();
	control(tree, "Board 1 name or link").onChangeText("https://jobs.lever.co/acme/123?source=x");
	tree = screen.render();
	assert.equal(control(tree, "Board 1 source").value, "lever");
	assert.equal(control(tree, "Board 1 name or link").value, "acme");
	control(tree, "Create search").onPress();
	await flush();
	assert.equal(calls.create.length, 1);
	assert.deepEqual(calls.create[0].boards, [{ source: "lever", token: "acme" }]);
	assert.deepEqual(calls.create[0].titles, ["Product Manager", "Product Owner"]);
	assert.equal(calls.create[0].name, "Remote PM");
	assert.equal(calls.create[0].schedule, "daily");
	assert.equal(closed, 1);
	assert.ok(calls.invalidated.includes("sources"));
});

test("a board link from an unsupported host shows a message and blocks the save", async () => {
	const { form, calls } = setup();
	const screen = mount(form.SearchForm, { showAi: false, onClose() {} });
	let tree = screen.render();
	control(tree, "Name").onChangeText("x");
	tree = screen.render();
	control(tree, "Add a board").onPress();
	tree = screen.render();
	control(tree, "Board 1 name or link").onChangeText("https://www.linkedin.com/jobs/view/1");
	tree = screen.render();
	assert.equal(control(tree, "Board 1 name or link").error, "This board isn't supported yet");
	control(tree, "Create search").onPress();
	await flush();
	assert.equal(calls.create.length, 0);
});

test("the AI field shows only with platform_ai, explains credits and checks 0 to 50", async () => {
	const { form, calls } = setup();
	const screen = mount(form.SearchForm, { showAi: true, onClose() {} });
	let tree = screen.render();
	const ai = control(tree, "Jobs to score with AI per run");
	assert.ok(ai);
	assert.match(ai.helper, /uses AI credits/);
	control(tree, "Name").onChangeText("AI search");
	tree = screen.render();
	control(tree, "Jobs to score with AI per run").onChangeText("51");
	tree = screen.render();
	control(tree, "Create search").onPress();
	await flush();
	tree = screen.render();
	assert.equal(calls.create.length, 0);
	assert.equal(control(tree, "Jobs to score with AI per run").error, "Enter a whole number from 0 to 50.");
	control(tree, "Jobs to score with AI per run").onChangeText("0");
	tree = screen.render();
	control(tree, "Create search").onPress();
	await flush();
	assert.equal(calls.create[0].aiTopN, 0);
});

test("a failed save keeps the form and maps the server's field error", async () => {
	const { form, calls, state } = setup();
	const screen = mount(form.SearchForm, { showAi: false, onClose() {} });
	let tree = screen.render();
	control(tree, "Create search").onPress();
	await flush();
	tree = screen.render();
	assert.equal(control(tree, "Name").error, "Give this search a name.");
	assert.equal(calls.create.length, 0);

	control(tree, "Name").onChangeText("Keep me");
	tree = screen.render();
	state.fail = { data: { issues: [{ code: "too_big", path: ["name"] }] } };
	control(tree, "Create search").onPress();
	await flush();
	tree = screen.render();
	assert.equal(calls.create.length, 1);
	assert.equal(control(tree, "Name").value, "Keep me");
	assert.equal(control(tree, "Name").error, "Use at most 120 characters.");
});

test("a create refused at the search limit shows the limit message", async () => {
	const { form, state } = setup();
	const screen = mount(form.SearchForm, { showAi: false, onClose() {} });
	let tree = screen.render();
	control(tree, "Name").onChangeText("One more");
	tree = screen.render();
	state.fail = { code: "BAD_REQUEST", data: { code: "AUTOMATION_LIMIT_REACHED", limit: 20 } };
	control(tree, "Create search").onPress();
	await flush();
	tree = screen.render();
	assert.ok(text(tree).includes("You can have at most 20 searches. Delete one to add another."));
	assert.equal(control(tree, "Name").value, "One more");
});

test("edit: the form starts from the saved search and saves through update with its id", async () => {
	const { form, calls } = setup();
	const screen = mount(form.SearchForm, { source: source(), showAi: false, onClose() {} });
	let tree = screen.render();
	assert.equal(control(tree, "Name").value, "Product roles");
	assert.equal(control(tree, "Board 1 name or link").value, "acme");
	control(tree, "Name").onChangeText("Renamed");
	tree = screen.render();
	control(tree, "Save changes").onPress();
	await flush();
	assert.equal(calls.create.length, 0);
	assert.equal(calls.update.length, 1);
	assert.equal(calls.update[0].id, "s1");
	assert.equal(calls.update[0].name, "Renamed");
});

test("plan gate: without job_discovery the section is read-only with a plan note", () => {
	const { section } = setup({ features: {}, sources: [source()], runs: [run()] });
	const screen = mount(section.SearchesSection, {});
	const tree = screen.render();
	assert.ok(text(tree).some((line) => line.includes("plan doesn't include job discovery")));
	assert.equal(control(tree, "New search"), undefined);
	const row = nodes(tree).find((node) => node.type === section.SearchRow);
	assert.ok(row, "the saved search is still listed");
	assert.equal(row.props.readOnly, true);
	const rowTree = mount(section.SearchRow, row.props).render();
	for (const label of ["Run now", "Pause", "Edit", "Delete"]) assert.equal(control(rowTree, label), undefined, label);
});

test("empty state explains the section and opens the form from New search", () => {
	const { section } = setup({ sources: [] });
	const screen = mount(section.SearchesSection, {});
	let tree = screen.render();
	const empty = nodes(tree).find((node) => node.type === "EmptyState");
	assert.ok(empty);
	assert.match(empty.props.message, /runs on its own/);
	empty.props.action.onPress();
	tree = screen.render();
	const form = nodes(tree).find((node) => node.type === "SearchForm");
	assert.ok(form);
	assert.equal(form.props.showAi, false);
});

test("with platform_ai the section passes showAi to the form", () => {
	const { section } = setup({ features: { job_discovery: true, platform_ai: true }, sources: [source()] });
	const screen = mount(section.SearchesSection, {});
	let tree = screen.render();
	control(tree, "New search").onPress();
	tree = screen.render();
	assert.equal(nodes(tree).find((node) => node.type === "SearchForm").props.showAi, true);
});

test("a row lists schedule, next run, last run status and the new job count", () => {
	const { section } = setup({ runs: [run({ status: "partial", new: 7 })] });
	const tree = mount(section.SearchRow, { source: source(), readOnly: false, onEdit() {}, onDeleted() {} }).render();
	const lines = text(tree);
	assert.ok(lines.some((line) => line.includes("Daily") && line.includes("Finished with errors")));
	assert.ok(lines.includes("Next run: D:2026-11-09"));
	assert.ok(lines.includes("Last run: D:2026-11-08"));
	assert.ok(lines.includes("New jobs in the last run: 7"));
});

test("pause and resume update the schedule", async () => {
	const first = setup({ runs: [run()] });
	let tree = mount(first.section.SearchRow, {
		source: source(),
		readOnly: false,
		onEdit() {},
		onDeleted() {},
	}).render();
	control(tree, "Pause").onPress();
	await flush();
	assert.deepEqual(first.calls.update, [{ id: "s1", schedule: "paused" }]);

	const second = setup({ runs: [run()] });
	tree = mount(second.section.SearchRow, {
		source: source({ schedule: "paused", nextRunAt: null }),
		readOnly: false,
		onEdit() {},
		onDeleted() {},
	}).render();
	assert.ok(text(tree).includes("Next run: paused"));
	control(tree, "Resume").onPress();
	await flush();
	assert.deepEqual(second.calls.update, [{ id: "s1", schedule: "daily" }]);
});

test("delete asks first and only deletes on confirm", async () => {
	const { section, calls } = setup({ runs: [run()] });
	let deleted = 0;
	const row = mount(section.SearchRow, { source: source(), readOnly: false, onEdit() {}, onDeleted: () => deleted++ });
	let tree = row.render();
	assert.equal(nodes(tree).find((node) => node.type === "ConfirmDialog").props.open, false);
	control(tree, "Delete").onPress();
	tree = row.render();
	const dialog = nodes(tree).find((node) => node.type === "ConfirmDialog").props;
	assert.equal(dialog.open, true);
	assert.equal(calls.remove.length, 0);
	dialog.onCancel();
	tree = row.render();
	assert.equal(nodes(tree).find((node) => node.type === "ConfirmDialog").props.open, false);
	assert.equal(calls.remove.length, 0);

	control(tree, "Delete").onPress();
	tree = row.render();
	nodes(tree)
		.find((node) => node.type === "ConfirmDialog")
		.props.onConfirm();
	await flush();
	assert.deepEqual(calls.remove, [{ id: "s1" }]);
	assert.equal(deleted, 1);
});

test("run now shows Running, polls every 5 seconds and stops when the run has finished", async () => {
	const { section, calls, state } = setup({ runs: [run()] });
	const row = mount(section.SearchRow, { source: source(), readOnly: false, onEdit() {}, onDeleted() {} });
	let tree = row.render();
	state.runs = [run({ runId: "r2", status: "running", new: 0, finishedAt: null }), run()];
	control(tree, "Run now").onPress();
	await flush();
	tree = row.render();
	assert.deepEqual(calls.runNow, [{ jobSourceId: "s1" }]);
	assert.ok(control(tree, "Running"), "the button says Running");
	assert.equal(control(tree, "Running").disabled, true);
	assert.equal(calls.intervals.at(-1), 5000);

	state.runs = [run({ runId: "r2", status: "succeeded", new: 3 }), run()];
	tree = row.render();
	assert.ok(control(tree, "Run now"), "the run is over");
	assert.equal(calls.intervals.at(-1), false);
	assert.ok(calls.toasts.some((message) => message.includes("finished: 3 new")));
	assert.ok(calls.invalidated.includes("jobs"));
});

test("a run that is already going when the screen opens is followed for 3 minutes from its start", () => {
	const going = run({ runId: "r3", status: "running", new: 0, finishedAt: null, startedAt: new Date().toISOString() });
	const fresh = setup({ runs: [going] });
	let tree = mount(fresh.section.SearchRow, {
		source: source(),
		readOnly: false,
		onEdit() {},
		onDeleted() {},
	}).render();
	assert.ok(control(tree, "Running"));
	assert.equal(fresh.calls.intervals.at(-1), 5000);

	const old = setup({ runs: [{ ...going, startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }] });
	tree = mount(old.section.SearchRow, { source: source(), readOnly: false, onEdit() {}, onDeleted() {} }).render();
	assert.ok(control(tree, "Running"), "the server still says it is running");
	assert.equal(old.calls.intervals.at(-1), false, "but the screen stops asking after 3 minutes");
});
