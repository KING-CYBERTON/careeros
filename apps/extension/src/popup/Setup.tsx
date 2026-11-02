import type { OrgBranding } from "../lib/branding";
import type { Connection } from "../lib/storage";
import { useId, useState } from "react";
import { Alert } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { normalizeOrigin } from "../lib/address";
import { fetchHostBranding } from "../lib/branding";
import { DEV_HTTP_HOSTS } from "../lib/config";
import { releaseOrigin, requestOrigin, saveConnection } from "../lib/storage";
import { OrgMark } from "./OrgMark";
import { strings } from "./strings";

type Step = { kind: "enter" } | { kind: "checking" } | { kind: "confirm"; origin: string; branding: OrgBranding };

type SetupProps = {
	onConnected: (connection: Connection) => void;
};

/** First run: the user enters the organization's address, the popup shows who it is, and the browser is asked for that one origin only after the user confirms. */
export function Setup(props: SetupProps) {
	const inputId = useId();
	const errorId = useId();
	const [value, setValue] = useState("");
	const [step, setStep] = useState<Step>({ kind: "enter" });
	const [error, setError] = useState<string | null>(null);
	const [asking, setAsking] = useState(false);

	// The branding check needs no host permission: the server answers extension origins (CORS). The permission is asked
	// for only after the user confirms the organization.
	async function check(origin: string) {
		setStep({ kind: "checking" });
		const result = await fetchHostBranding(origin, DEV_HTTP_HOSTS);
		if (!result.ok) {
			setError(strings.branding[result.reason]);
			setStep({ kind: "enter" });
			return;
		}
		setStep({ kind: "confirm", origin, branding: result.branding });
	}

	function submit(event: React.SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		if (step.kind !== "enter") return;
		const address = normalizeOrigin(value, DEV_HTTP_HOSTS);
		if (!address.ok) {
			setError(strings.address[address.reason]);
			return;
		}
		setError(null);
		void check(address.origin);
	}

	// The permission request is the first call of this function, with no await before it: the browser only shows its
	// prompt for a click. The connection is stored only after the permission is granted.
	async function confirm(origin: string, branding: OrgBranding) {
		setError(null);
		setAsking(true);
		let granted = false;
		try {
			granted = await requestOrigin(origin);
		} catch {
			granted = false;
		}
		if (!granted) {
			setAsking(false);
			setError(strings.permissionDenied);
			return;
		}
		const connection: Connection = {
			origin,
			orgName: branding.orgName,
			logoUrl: branding.logoUrl,
			primaryColor: branding.primaryColor,
		};
		try {
			await saveConnection(connection);
		} catch {
			await releaseOrigin(origin);
			setAsking(false);
			setError(strings.saveFailed);
			return;
		}
		props.onConnected(connection);
	}

	function goBack() {
		setError(null);
		setStep({ kind: "enter" });
	}

	if (step.kind === "confirm") {
		const { origin, branding } = step;
		return (
			<div className="flex flex-col gap-4 p-4">
				<h1 className="text-base font-semibold text-ink">{strings.confirmTitle}</h1>
				<div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3">
					<OrgMark orgName={branding.orgName} logoUrl={branding.logoUrl} className="size-12" />
					<div className="min-w-0">
						<p className="truncate text-sm font-semibold text-ink">{branding.orgName}</p>
						<p className="truncate text-xs text-ink-3">{origin}</p>
					</div>
				</div>
				{error ? <Alert variant="error">{error}</Alert> : null}
				<div className="flex gap-2">
					<Button variant="secondary" disabled={asking} onClick={goBack}>
						{strings.back}
					</Button>
					<Button className="flex-1" onClick={() => void confirm(origin, branding)}>
						{strings.confirm}
					</Button>
				</div>
			</div>
		);
	}

	const busy = step.kind !== "enter";
	return (
		<form className="flex flex-col gap-4 p-4" onSubmit={submit} noValidate>
			<div className="flex flex-col gap-1">
				<h1 className="text-base font-semibold text-ink">{strings.setupTitle}</h1>
				<p className="text-[13px] leading-[19px] text-ink-2">{strings.setupIntro}</p>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={inputId}>{strings.addressLabel}</Label>
				<Input
					id={inputId}
					type="text"
					inputMode="url"
					autoComplete="url"
					autoCapitalize="none"
					spellCheck={false}
					placeholder={strings.addressPlaceholder}
					value={value}
					disabled={busy}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? errorId : undefined}
					onChange={(event) => setValue(event.target.value)}
				/>
			</div>
			{error ? (
				<Alert variant="error" id={errorId}>
					{error}
				</Alert>
			) : null}
			<Button type="submit" loading={busy}>
				{step.kind === "checking" ? strings.checking : strings.connect}
			</Button>
			<p className="text-xs leading-4 text-ink-3">{strings.permissionNote}</p>
		</form>
	);
}
