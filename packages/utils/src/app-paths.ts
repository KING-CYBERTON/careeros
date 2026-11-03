/** The signed-in app's sections. On the alias domain (`APP_ALIAS_URL`) they move to `APP_URL`, where sign-in lives. */
// CAREEROS (P5-T02): "device" is the Job Clipper approval page; as a section the server answers it and no username can take it.
export const APP_SECTIONS = ["auth", "dashboard", "builder", "agent", "device"] as const;

/** First path segments the app owns besides its sections: never a username, so never a resume's web page. */
export const RESERVED_SEGMENTS = [
	...APP_SECTIONS,
	"api",
	"mcp",
	".well-known",
	"uploads",
	"templates",
	"ats-checker",
	"resume-templates",
	// CAREEROS: the public open-source licenses page (P2-T08).
	"licenses",
	// CAREEROS: the public terms, privacy and data processing pages (P6-T01).
	"terms",
	"privacy",
	"dpa",
] as const;

/** Whether `pathname` is in one of the signed-in app's sections. */
export const isAppSectionPath = (pathname: string) =>
	APP_SECTIONS.some((section) => pathname === `/${section}` || pathname.startsWith(`/${section}/`));
