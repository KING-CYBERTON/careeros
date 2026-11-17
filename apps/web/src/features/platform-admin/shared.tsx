import type { ReactNode } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { Icon } from "@reactive-resume/ui/components/icon";
import { toast } from "@reactive-resume/ui/components/toast";
import { getReadableErrorMessage } from "@/libs/error-message";

// CAREEROS (P3-T07): small helpers the console's pages share.

/** Better Auth stores roles as a comma separated list; a platform admin has `admin` in it. The server checks for real. */
export function isPlatformAdmin(role: string | null | undefined): boolean {
	return (role ?? "")
		.split(",")
		.map((value) => value.trim())
		.includes("admin");
}

/** The error code the console's procedures put in `data.code`. */
export function adminErrorCode(error: unknown): string | undefined {
	if (!(error instanceof ORPCError)) return undefined;
	const data: unknown = error.data;
	return data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : undefined;
}

export function formatDate(value: Date | string | null | undefined): string {
	if (!value) return "-";
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

/** Minor units (cents) in the currency's own format. */
export function formatMoney(amountMinor: number, currency: string): string {
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
	} catch {
		return `${(amountMinor / 100).toFixed(2)} ${currency}`;
	}
}

/** USD millionths, as dollars. */
export function formatMicros(micros: number): string {
	return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(
		micros / 1_000_000,
	);
}

type ErrorNoticeProps = { error: unknown; title?: ReactNode };

export function ErrorNotice({ error, title }: ErrorNoticeProps) {
	return (
		<Alert variant="error" data-testid="admin-error">
			<Icon name="warning" />
			<AlertTitle>{title ?? <Trans>Something went wrong</Trans>}</AlertTitle>
			<AlertDescription>{getReadableErrorMessage(error, t`Try again in a moment.`)}</AlertDescription>
		</Alert>
	);
}

export function NotFoundPage() {
	return (
		<div className="mx-auto grid max-w-md gap-2 px-4 py-24 text-center" data-testid="admin-not-found">
			<h1 className="font-display text-[30px] leading-9 font-medium">
				<Trans>Page not found</Trans>
			</h1>
			<p className="text-sm text-ink-2">
				<Trans>The page you are looking for does not exist.</Trans>
			</p>
		</div>
	);
}

/** A toast for the result of a console action. */
export const notify = {
	success: (description: string) => toast.add({ type: "success", description }),
	error: (description: string) => toast.add({ type: "error", description }),
};
