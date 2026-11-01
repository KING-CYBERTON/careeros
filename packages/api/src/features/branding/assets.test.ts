import { describe, expect, it } from "vite-plus/test";
import sharp from "sharp";
import { sanitizeSvg, validateFavicon, validateLogo } from "./assets";
import { FAVICON_MAX_BYTES, LOGO_MAX_BYTES } from "./schemas";

const png = () =>
	sharp({ create: { width: 8, height: 8, channels: 4, background: "#336699" } })
		.png()
		.toBuffer();
const webp = () =>
	sharp({ create: { width: 8, height: 8, channels: 4, background: "#336699" } })
		.webp()
		.toBuffer();
const gif = () =>
	sharp({ create: { width: 8, height: 8, channels: 4, background: "#336699" } })
		.gif()
		.toBuffer();
const ico = () => Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
const file = (data: BlobPart, type = "application/octet-stream", name = "upload") => new File([data], name, { type });
const SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Logo</title><circle cx="5" cy="5" r="4" fill="#336699"/><path d="M0 0L10 10" stroke="black"/></svg>`;

describe("validateLogo", () => {
	it("accepts PNG, WebP and SVG and reports the real type, not the declared one", async () => {
		expect(await validateLogo(file(await png(), "image/jpeg", "logo.jpg"))).toMatchObject({
			contentType: "image/png",
			extension: "png",
		});
		expect(await validateLogo(file(await webp(), "image/png"))).toMatchObject({
			contentType: "image/webp",
			extension: "webp",
		});
		expect(await validateLogo(file(SVG, "text/plain"))).toMatchObject({
			contentType: "image/svg+xml",
			extension: "svg",
		});
	});

	it("rejects other formats, text that is not an image and corrupt images", async () => {
		await expect(validateLogo(file(await gif(), "image/gif"))).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(validateLogo(file(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])))).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(validateLogo(file("<html><body>hi</body></html>", "image/png"))).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		const broken = Buffer.concat([(await png()).subarray(0, 40)]);
		await expect(validateLogo(file(broken, "image/png"))).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(validateLogo(file(await ico()))).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("rejects a file over 512 KB", async () => {
		await expect(validateLogo(file(new Uint8Array(LOGO_MAX_BYTES + 1)))).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("validateFavicon", () => {
	it("accepts PNG and ICO", async () => {
		expect(await validateFavicon(file(await png()))).toMatchObject({ contentType: "image/png", extension: "png" });
		expect(await validateFavicon(file(await ico()))).toMatchObject({ contentType: "image/x-icon", extension: "ico" });
	});

	it("rejects WebP, SVG and GIF, and a file over 128 KB", async () => {
		await expect(validateFavicon(file(await webp()))).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(validateFavicon(file(SVG))).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(validateFavicon(file(await gif()))).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(validateFavicon(file(new Uint8Array(FAVICON_MAX_BYTES + 1)))).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
});

describe("sanitizeSvg", () => {
	it("keeps shapes and drops nothing drawable", () => {
		const clean = sanitizeSvg(SVG);
		expect(clean.startsWith("<svg")).toBe(true);
		expect(clean).toContain('viewBox="0 0 10 10"');
		expect(clean).toContain("<circle");
		expect(clean).toContain("<path");
	});

	it.each([
		[
			"a script element",
			`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>`,
		],
		[
			"an event handler",
			`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>`,
		],
		[
			"a style element",
			`<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:red}</style><rect width="1" height="1"/></svg>`,
		],
		["foreignObject", `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>`],
		[
			"a doctype with an entity",
			`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`,
		],
		[
			"an external url reference",
			`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="url(https://evil.example/x)"/></svg>`,
		],
	])("refuses %s", (_name, source) => {
		expect(() => sanitizeSvg(source)).toThrow();
	});

	it("strips what is not on the allowlist but keeps the drawing", () => {
		const clean = sanitizeSvg(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><a href="javascript:alert(1)"><rect width="2" height="2" fill="url(#g)"/></a><image href="https://evil.example/x.png"/><use href="#x"/></svg>`,
		);
		expect(clean).not.toMatch(/javascript|<a|<image|<use|href/i);
		expect(clean).toContain("<rect");
	});

	it("refuses a document that is not an SVG after sanitizing", () => {
		expect(() => sanitizeSvg(`<svg><script>x</script>`)).toThrow();
		expect(() => sanitizeSvg("hello")).toThrow();
	});
});
