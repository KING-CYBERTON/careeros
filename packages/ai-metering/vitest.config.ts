import { fileURLToPath } from "node:url";
// @boundaries-ignore root shared Vitest config
import { createVitestProjectConfig } from "../../vitest.shared.mts";

export default createVitestProjectConfig({
	name: "@careeros/ai-metering",
	dirname: fileURLToPath(new URL(".", import.meta.url)),
});
