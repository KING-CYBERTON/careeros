// CAREEROS (P5-T01): build-time settings. A production build has no http host.
export const DEV_HTTP_HOSTS: readonly string[] = typeof __DEV_HTTP_HOSTS__ === "undefined" ? [] : __DEV_HTTP_HOSTS__;
