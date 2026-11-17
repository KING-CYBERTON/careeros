// CAREEROS: web access to the brand. `getBrand()` reads `window.__BRAND__` (injected by the server shell in P2-T02)
// and falls back to the platform default, so no component hard-codes the product name.
export { getBrand } from "@reactive-resume/utils/brand";
