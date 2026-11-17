import type { StoredTemplate } from "./resolve";
import { describe, expect, it } from "vite-plus/test";
import { defaultForStage, resolveTemplates, suitsStage, templatesForStage } from "./resolve";

const stored = (patch: Partial<StoredTemplate> & Pick<StoredTemplate, "id">): StoredTemplate => ({
	kind: "follow_up",
	stageCategory: null,
	name: patch.id,
	subject: "s",
	body: "b",
	...patch,
});

describe("resolveTemplates", () => {
	it("offers the four built-ins when nothing is customised", () => {
		const list = resolveTemplates({ org: [], mine: [] });
		expect(list.map((entry) => entry.source)).toEqual(["builtin", "builtin", "builtin", "builtin"]);
		expect(list.map((entry) => entry.kind).sort()).toEqual(["follow_up", "negotiation", "networking", "thank_you"]);
	});

	it("replaces the built-in of a kind with the organization's default of that kind", () => {
		const list = resolveTemplates({ org: [stored({ id: "o1", kind: "follow_up" })], mine: [] });
		expect(list.filter((entry) => entry.kind === "follow_up").map((entry) => entry.id)).toEqual(["o1"]);
		expect(list).toHaveLength(4);
	});

	it("lists mine first and never lets a personal template replace a built-in", () => {
		const list = resolveTemplates({ org: [], mine: [stored({ id: "m1", kind: "thank_you" })] });
		expect(list[0]).toMatchObject({ id: "m1", source: "mine" });
		expect(list.filter((entry) => entry.kind === "thank_you")).toHaveLength(2);
	});

	it("turns a stored stage into a one-stage suggestion", () => {
		const [entry] = resolveTemplates({ org: [], mine: [stored({ id: "m1", stageCategory: "offer" })] });
		expect(entry?.stageCategories).toEqual(["offer"]);
	});
});

describe("the fallback order for a stage: mine, then the organization's, then the built-in", () => {
	const list = resolveTemplates({
		org: [stored({ id: "o1", kind: "follow_up", stageCategory: "applied" })],
		mine: [stored({ id: "m1", kind: "follow_up", stageCategory: "applied" })],
	});

	it("picks mine when it suits the stage", () => {
		expect(defaultForStage(list, "applied")?.id).toBe("m1");
	});

	it("falls back to the organization's default, then to the built-in", () => {
		const withoutMine = list.filter((entry) => entry.source !== "mine");
		expect(defaultForStage(withoutMine, "applied")?.id).toBe("o1");
		const builtInOnly = resolveTemplates({ org: [], mine: [] });
		expect(defaultForStage(builtInOnly, "applied")?.source).toBe("builtin");
		expect(defaultForStage(builtInOnly, "applied")?.kind).toBe("follow_up");
	});

	it("offers the built-in that fits each stage", () => {
		const builtInOnly = resolveTemplates({ org: [], mine: [] });
		expect(defaultForStage(builtInOnly, "interview")?.kind).toBe("thank_you");
		expect(defaultForStage(builtInOnly, "offer")?.kind).toBe("negotiation");
		expect(defaultForStage(builtInOnly, "saved")?.kind).toBe("networking");
		expect(defaultForStage(builtInOnly, "closed")).toBeUndefined();
	});

	it("puts a template for the stage before one for any stage", () => {
		const any = stored({ id: "any", kind: "custom" });
		const ordered = templatesForStage(resolveTemplates({ org: [], mine: [any] }), "applied");
		expect(ordered.map((entry) => entry.id)).toEqual(["builtin:follow_up", "any"]);
	});

	it("treats a template with no stage as suiting every stage", () => {
		expect(suitsStage({ stageCategories: [] }, "closed")).toBe(true);
		expect(suitsStage({ stageCategories: ["offer"] }, "closed")).toBe(false);
	});
});
