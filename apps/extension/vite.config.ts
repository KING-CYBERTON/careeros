import type { Plugin } from "vite-plus";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { buildManifest } from "./src/manifest";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
	version: string;
};

/**
 * The hosts a development build may reach over http: `localhost` unless EXTENSION_DEV_HTTP_HOSTS lists others
 * (comma separated; `*.suffix` for subdomains). A production build lists none, so it cannot reach any http address.
 */
function developmentHosts(mode: string): string[] {
	if (mode === "production") return [];
	const listed = (process.env.EXTENSION_DEV_HTTP_HOSTS ?? "localhost").split(",");
	return listed.map((host) => host.trim().toLowerCase()).filter((host) => host !== "");
}

/** Writes manifest.json into the build, from package.json's version. */
const manifestPlugin = (devHttpHosts: string[]): Plugin => ({
	name: "careeros-extension-manifest",
	generateBundle() {
		this.emitFile({
			type: "asset",
			fileName: "manifest.json",
			source: `${JSON.stringify(buildManifest({ version, devHttpHosts }), null, "\t")}\n`,
		});
	},
});

/**
 * The shared stylesheet (packages/ui globals.css) pulls in every web font and the 3 MB icon font the resume pages use.
 * The popup needs only the UI typeface, so the rest resolve to an empty file and stay out of the extension package.
 */
const emptyCss = fileURLToPath(new URL("./src/popup/empty.css", import.meta.url));
const unusedStyles = [
	/^@phosphor-icons\/web\/.*$/,
	/^@fontsource\/instrument-serif\/.*$/,
	/^@fontsource-variable\/geist-mono\/.*$/,
	/^@fontsource-variable\/figtree\/wght-italic\.css$/,
].map((find) => ({ find, replacement: emptyCss }));

export default defineConfig(({ mode }) => {
	const devHttpHosts = developmentHosts(mode);
	return {
		// Extension pages load their files relative to the package root.
		base: "./",
		resolve: { alias: unusedStyles },
		define: {
			__DEV_HTTP_HOSTS__: JSON.stringify(devHttpHosts),
		},
		plugins: [tailwindcss(), viteReact(), manifestPlugin(devHttpHosts)],
		build: {
			outDir: "dist",
			emptyOutDir: true,
			// The page policy has no data: sources, so nothing is inlined.
			assetsInlineLimit: 0,
			sourcemap: false,
			// The extension loads from disk; the shared UI bundle is about 740 kB.
			chunkSizeWarningLimit: 1024,
			rolldownOptions: {
				input: {
					popup: "popup.html",
					"service-worker": "src/background/service-worker.ts",
				},
				output: {
					// The manifest names the worker's file, so it has no hash.
					entryFileNames: (chunk) =>
						chunk.name === "service-worker" ? "service-worker.js" : "assets/[name]-[hash].js",
				},
			},
		},
	};
});
