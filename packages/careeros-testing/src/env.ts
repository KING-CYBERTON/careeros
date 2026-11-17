export type CareerosTestEnv = {
	/** Owner/superuser connection. Used only for setup and teardown, never for reads under test. */
	ownerUrl: string;
	/** Non-superuser, non-BYPASSRLS (`careeros_app`) connection. All reads under test go through it. */
	appUrl: string;
};

export const OWNER_URL_VAR = "CAREEROS_TEST_DATABASE_URL";
export const APP_URL_VAR = "CAREEROS_TEST_APP_DATABASE_URL";

function required(source: Record<string, string | undefined>, name: string): string {
	const value = source[name];
	if (!value) throw new Error(`Missing required test environment variable ${name}.`);
	return value;
}

export function getTestEnv(source: Record<string, string | undefined> = process.env): CareerosTestEnv {
	return { ownerUrl: required(source, OWNER_URL_VAR), appUrl: required(source, APP_URL_VAR) };
}
