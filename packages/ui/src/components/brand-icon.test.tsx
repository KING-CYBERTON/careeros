import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BrandIcon } from "./brand-icon";

const brandGlobal = globalThis as { __BRAND__?: unknown };

afterEach(() => {
	delete brandGlobal.__BRAND__;
});

describe("BrandIcon", () => {
	it("shows the platform mark in light and dark without an organization logo", () => {
		const { container } = render(<BrandIcon variant="icon" />);
		const sources = [...container.querySelectorAll("img")].map((image) => image.getAttribute("src"));
		expect(sources).toEqual(["/icon/dark.svg", "/icon/light.svg"]);
	});

	it("shows the organization's logo once, named after the brand", () => {
		brandGlobal.__BRAND__ = { appName: "Acme Careers", logoUrl: "/api/branding-assets/org_acme/logo.png" };
		render(<BrandIcon />);
		const image = screen.getByAltText("Acme Careers");
		expect(image).toHaveAttribute("src", "/api/branding-assets/org_acme/logo.png");
		expect(screen.getAllByRole("img")).toHaveLength(1);
	});
});
