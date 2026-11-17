import { fileURLToPath } from "node:url";
// @boundaries-ignore root shared Vitest config
import { createVitestProjectConfig } from "../../vitest.shared.mts";

export default createVitestProjectConfig({
	name: "@careeros/platform-admin",
	dirname: fileURLToPath(new URL(".", import.meta.url)),
});
