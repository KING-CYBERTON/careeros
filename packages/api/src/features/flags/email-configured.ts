export type EmailConfigEnv = {
	EMAIL_PROVIDER?: "plunk" | "smtp" | "log" | undefined;
	PLUNK_SECRET_KEY?: string | undefined;
	EMAIL_FROM_ADDRESS?: string | undefined;
	SMTP_HOST?: string | undefined;
	SMTP_USER?: string | undefined;
	SMTP_PASS?: string | undefined;
	SMTP_FROM?: string | undefined;
};

/**
 * True when outbound email would really be sent (Plunk or SMTP), false when it would only be logged.
 * Mirrors resolveEmailProvider() in packages/email/src/transport.ts (kept local to avoid an api -> email dependency).
 * The two must stay in step: change one, change the other.
 */
export const isEmailConfigured = (config: EmailConfigEnv): boolean => {
	if (config.EMAIL_PROVIDER === "plunk") return Boolean(config.PLUNK_SECRET_KEY && config.EMAIL_FROM_ADDRESS);
	if (config.EMAIL_PROVIDER) return config.EMAIL_PROVIDER !== "log";
	return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS && config.SMTP_FROM);
};
