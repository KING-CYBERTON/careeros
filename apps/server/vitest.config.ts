import { fileURLToPath } from "node:url";
// @boundaries-ignore root shared Vitest config
import { createVitestProjectConfig } from "../../vitest.shared.mts";

export default createVitestProjectConfig({
	name: "server",
	dirname: fileURLToPath(new URL(".", import.meta.url)),
	// CAREEROS: gives upstream MCP tests an active organization (P1-T02)
	extraSetupFiles: [fileURLToPath(new URL("./vitest.org.setup.ts", import.meta.url))],
});
