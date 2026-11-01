import { ORPCError } from "@orpc/server";
import sanitizeHtml from "sanitize-html";
import sharp from "sharp";
import { env } from "@reactive-resume/env/server";
import { FAVICON_MAX_BYTES, LOGO_MAX_BYTES } from "./schemas";

// CAREEROS (P2-T01): validation of branding uploads. The client-declared type is never trusted: the format comes from
// the file's first bytes. Raster images are checked and stored as they are (a logo keeps its transparency); SVG is
// sanitized with the repo's `sanitize-html`, because an SVG served from the app origin can run script.

export type BrandingAsset = { data: Uint8Array; contentType: string; extension: string };

const invalid = (message: string) => new ORPCError("BAD_REQUEST", { message });

const ascii = (bytes: Uint8Array, start: number, length: number) =>
	String.fromCharCode(...bytes.subarray(start, start + length));

function detectFormat(bytes: Uint8Array): "png" | "webp" | "ico" | "svg" | undefined {
	if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
	if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "ico";
	// Text: an SVG may start with a BOM, an XML declaration or comments, so look for the root element.
	if (/<svg[\s>]/i.test(new TextDecoder("utf-8").decode(bytes.subarray(0, 4096)))) return "svg";
	return undefined;
}

const SVG_TAGS = [
	"svg",
	"g",
	"path",
	"circle",
	"ellipse",
	"rect",
	"line",
	"polyline",
	"polygon",
	"defs",
	"linearGradient",
	"radialGradient",
	"stop",
	"clipPath",
	"mask",
	"title",
	"desc",
	"text",
	"tspan",
];

const PRESENTATION = [
	"fill",
	"fill-opacity",
	"fill-rule",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-miterlimit",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-opacity",
	"opacity",
	"clip-path",
	"clip-rule",
	"mask",
	"transform",
	"id",
];

const SVG_ATTRIBUTES: Record<string, string[]> = {
	svg: ["xmlns", "viewBox", "width", "height", "preserveAspectRatio", "role", ...PRESENTATION],
	g: PRESENTATION,
	path: ["d", ...PRESENTATION],
	circle: ["cx", "cy", "r", ...PRESENTATION],
	ellipse: ["cx", "cy", "rx", "ry", ...PRESENTATION],
	rect: ["x", "y", "width", "height", "rx", "ry", ...PRESENTATION],
	line: ["x1", "y1", "x2", "y2", ...PRESENTATION],
	polyline: ["points", ...PRESENTATION],
	polygon: ["points", ...PRESENTATION],
	defs: [],
	linearGradient: ["id", "x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod"],
	radialGradient: ["id", "cx", "cy", "r", "fx", "fy", "gradientUnits", "gradientTransform", "spreadMethod"],
	stop: ["offset", "stop-color", "stop-opacity"],
	clipPath: ["id", "clipPathUnits"],
	mask: ["id", "x", "y", "width", "height", "maskUnits", "maskContentUnits"],
	title: [],
	desc: [],
	text: ["x", "y", "dx", "dy", "font-family", "font-size", "font-weight", "text-anchor", ...PRESENTATION],
	tspan: ["x", "y", "dx", "dy", "font-family", "font-size", "font-weight", "text-anchor", ...PRESENTATION],
};

// Anything that can reach outside the file or run: external references, script URLs, entity or style tricks.
const FORBIDDEN_SOURCE = /<!(?:ENTITY|DOCTYPE)|<\?xml-stylesheet|<script|<foreignObject|<style|\son[a-z]+\s*=|@import/i;
const FORBIDDEN_OUTPUT =
	/javascript:|data:|vbscript:|url\(\s*(?!['"]?#)|expression\(|&#|&(?!amp;|lt;|gt;|quot;|apos;)/i;

/**
 * Returns the SVG reduced to an allowlist of shapes, gradients and text, or throws. Scripts, styles, event handlers,
 * links, embedded images, `foreignObject` and external references are removed or make the file unacceptable.
 */
export function sanitizeSvg(source: string): string {
	if (FORBIDDEN_SOURCE.test(source))
		throw invalid("This SVG contains scripts, styles or external references. Remove them and try again.");
	const clean = sanitizeHtml(source, {
		allowedTags: SVG_TAGS,
		allowedAttributes: SVG_ATTRIBUTES,
		allowedSchemes: [],
		allowProtocolRelative: false,
		disallowedTagsMode: "discard",
		parser: { xmlMode: true, lowerCaseTags: false, lowerCaseAttributeNames: false },
	}).trim();
	if (!/^<svg[\s>]/.test(clean) || !clean.endsWith("</svg>"))
		throw invalid("The SVG is not valid or has nothing drawable in it.");
	if (FORBIDDEN_OUTPUT.test(clean)) throw invalid("This SVG uses features that are not allowed in a logo.");
	return clean;
}

async function checkRaster(bytes: Uint8Array, format: "png" | "webp") {
	if (env.FLAG_DISABLE_IMAGE_PROCESSING) return;
	// The pixel cap stops a small file from decoding into a huge bitmap.
	const metadata = await sharp(bytes, { limitInputPixels: 25_000_000 })
		.metadata()
		.catch(() => undefined);
	if (!metadata || metadata.format !== format || !metadata.width || !metadata.height)
		throw invalid(`The file is not a valid ${format.toUpperCase()} image.`);
}

const CONTENT_TYPES = { png: "image/png", webp: "image/webp", ico: "image/x-icon", svg: "image/svg+xml" } as const;

/** Logo: PNG, SVG or WebP, at most 512 KB. */
export async function validateLogo(file: File): Promise<BrandingAsset> {
	if (file.size > LOGO_MAX_BYTES) throw invalid("The logo must be 512 KB or smaller.");
	const bytes = new Uint8Array(await file.arrayBuffer());
	const format = detectFormat(bytes);
	if (format !== "png" && format !== "webp" && format !== "svg")
		throw invalid("The logo must be a PNG, SVG or WebP image.");
	if (format === "svg") {
		let source: string;
		try {
			source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw invalid("The SVG is not valid UTF-8 text.");
		}
		const clean = sanitizeSvg(source);
		return { data: new TextEncoder().encode(clean), contentType: CONTENT_TYPES.svg, extension: "svg" };
	}
	await checkRaster(bytes, format);
	return { data: bytes, contentType: CONTENT_TYPES[format], extension: format };
}

/** Favicon: PNG or ICO, at most 128 KB. */
export async function validateFavicon(file: File): Promise<BrandingAsset> {
	if (file.size > FAVICON_MAX_BYTES) throw invalid("The favicon must be 128 KB or smaller.");
	const bytes = new Uint8Array(await file.arrayBuffer());
	const format = detectFormat(bytes);
	if (format !== "png" && format !== "ico") throw invalid("The favicon must be a PNG or ICO image.");
	if (format === "png") await checkRaster(bytes, "png");
	return { data: bytes, contentType: CONTENT_TYPES[format], extension: format };
}
