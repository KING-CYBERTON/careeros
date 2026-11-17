// CAREEROS (P5-T01): the Manifest V3 file, built from package.json's version by the Vite plugin in vite.config.ts and
// tested as it is emitted. The name carries no product brand: the organization's brand appears at run time (G5).

export type ManifestOptions = {
	version: string;
	/** Hosts a development build may reach over http (see address.ts). Empty in a production build. */
	devHttpHosts?: readonly string[];
};

const ICON_SIZES = [16, 32, 48, 128] as const;

const icons = Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]));

export function buildManifest({ version, devHttpHosts = [] }: ManifestOptions) {
	// Extension pages: own scripts only, no eval. Styles come from the stylesheet file (the brand colour is set through the
	// style object, which the policy allows). Logos are https images; connections are https. A development build also
	// reaches its listed http hosts.
	const devSources = devHttpHosts.map((host) => `http://${host}:*`);
	const csp = [
		"default-src 'self'",
		"script-src 'self'",
		"object-src 'self'",
		"style-src 'self'",
		"font-src 'self'",
		`img-src 'self' https: ${devSources.join(" ")}`.trim(),
		`connect-src https: ${devSources.join(" ")}`.trim(),
	].join("; ");

	return {
		manifest_version: 3,
		name: "Job Clipper",
		version,
		description: "Save job postings from the web to your organization's job tracker.",
		icons,
		action: { default_title: "Job Clipper", default_popup: "popup.html", default_icon: icons },
		background: { service_worker: "service-worker.js", type: "module" },
		permissions: ["activeTab", "storage", "scripting"],
		// No host access at install. The popup asks for the one organization origin the user enters, when they enter it.
		optional_host_permissions: ["https://*/*", ...devHttpHosts.map((host) => `http://${host}/*`)],
		content_security_policy: { extension_pages: csp },
	};
}
