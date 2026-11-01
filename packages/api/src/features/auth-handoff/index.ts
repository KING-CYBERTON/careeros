// CAREEROS (P2-T05): the public surface of the sign-in handoff, for the server's HTTP adapter.
export { consumeHandoffLimit } from "./rate-limit";
export { DEFAULT_RETURN_TO, sanitizeReturnTo } from "./return-to";
export {
	beginHandoff,
	getHandoffRequest,
	HANDOFF_COOKIE,
	HANDOFF_COOKIE_MAX_AGE_SECONDS,
	HANDOFF_COOKIE_PATH,
	handoffProviders,
	issueHandoff,
	purgeExpiredHandoffs,
	redeemHandoff,
} from "./service";
