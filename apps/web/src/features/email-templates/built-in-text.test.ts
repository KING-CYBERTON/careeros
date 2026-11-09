import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_TEMPLATES } from "@careeros/email-templates";
import { i18n } from "@lingui/core";
import { translateTemplate } from "./built-in-text";

describe("the built-in templates as translatable messages", () => {
	i18n.load("en", {});
	i18n.activate("en");

	it("read exactly like the shared English source, name, subject and body", () => {
		for (const item of BUILT_IN_TEMPLATES) {
			const translated = translateTemplate(i18n, { ...item, source: "builtin" as const });
			expect(translated.name).toBe(item.name);
			expect(translated.subject).toBe(item.subject);
			expect(translated.body).toBe(item.body);
		}
	});

	it("leave the stored templates' text alone", () => {
		const mine = { id: "x", source: "mine" as const, kind: "follow_up" as const, name: "n", subject: "s", body: "b" };
		expect(translateTemplate(i18n, mine)).toBe(mine);
	});
});
