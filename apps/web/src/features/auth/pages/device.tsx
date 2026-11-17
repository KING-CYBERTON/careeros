import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";
import { cn } from "@reactive-resume/utils/style";
import { getBrand } from "@/libs/brand";
import { ENTER_CLASS } from "@/libs/motion";

// CAREEROS (P5-T02): the page where a member approves the Job Clipper's sign-in (RFC 8628 verification page). The server
// only answers for a code requested on this same address, for a member of this address's organization; anything else
// reads as "that code is not valid". Approving is an explicit button press.

const CLIPPER_CLIENT_ID = "careeros-job-clipper";

type DevicePageProps = {
	userCode: string;
	email: string;
	onCode: (code: string) => void;
};

type Review =
	| { kind: "pending" | "approved" | "denied" }
	| { kind: "invalid" }
	| { kind: "not-member" }
	| { kind: "unsupported" };

async function review(userCode: string): Promise<Review> {
	const response = await fetch(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, {
		credentials: "same-origin",
		headers: { accept: "application/json" },
	});
	if (response.status === 403) return { kind: "not-member" };
	if (!response.ok) return { kind: "invalid" };
	const body = (await response.json()) as { status?: string; client_id?: string };
	// Only the clipper is known here; any other client id is not shown as approvable.
	if (body.client_id !== CLIPPER_CLIENT_ID) return { kind: "unsupported" };
	if (body.status === "approved" || body.status === "denied") return { kind: body.status };
	return { kind: "pending" };
}

async function decide(action: "approve" | "deny", userCode: string): Promise<boolean> {
	try {
		const response = await fetch(`/api/auth/device/${action}`, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ userCode }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

function CodeForm({ onCode }: { onCode: (code: string) => void }) {
	const [value, setValue] = useState("");
	return (
		<form
			className={cn(ENTER_CLASS, "space-y-4")}
			onSubmit={(event) => {
				event.preventDefault();
				if (value.trim()) onCode(value.trim());
			}}
		>
			<div className="space-y-2">
				<Label htmlFor="device-code">
					<Trans>Code from the extension</Trans>
				</Label>
				<Input
					id="device-code"
					value={value}
					autoComplete="off"
					autoCapitalize="characters"
					spellCheck={false}
					className="font-mono tracking-widest uppercase"
					onChange={(event) => setValue(event.target.value)}
				/>
			</div>
			<Button type="submit" className="w-full" disabled={!value.trim()}>
				<Trans>Continue</Trans>
			</Button>
		</form>
	);
}

export function DevicePage({ userCode, email, onCode }: DevicePageProps) {
	const organizationName = getBrand().appName;
	const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const reviewed = useQuery({
		queryKey: ["device-review", userCode],
		enabled: userCode !== "",
		retry: false,
		queryFn: () => review(userCode),
	});
	const state: Review["kind"] | "loading" | "none" =
		userCode === "" ? "none" : outcome ? outcome : reviewed.isPending ? "loading" : (reviewed.data?.kind ?? "invalid");

	async function submit(action: "approve" | "deny") {
		if (pending) return;
		setPending(true);
		setError(undefined);
		const ok = await decide(action, userCode);
		setPending(false);
		if (ok) setOutcome(action === "approve" ? "approved" : "denied");
		else setError(t`Couldn't complete this. Start again from the extension and try again.`);
	}

	return (
		<>
			<div className="space-y-2 text-center">
				<h1 className="text-[30px] leading-9">
					<Trans>Sign in the Job Clipper</Trans>
				</h1>
				<p className="text-sm wrap-anywhere text-ink-3">
					<Trans>Signed in as {email}</Trans>
				</p>
			</div>

			{state === "none" ? <CodeForm onCode={onCode} /> : null}
			{state === "loading" ? (
				<p role="status">
					<Trans>Checking the code...</Trans>
				</p>
			) : null}
			{state === "invalid" || state === "unsupported" ? (
				<div className={cn(ENTER_CLASS, "space-y-4")}>
					<p role="alert">
						<Trans>That code is not valid or has expired. Start again from the extension.</Trans>
					</p>
					<CodeForm onCode={onCode} />
				</div>
			) : null}
			{state === "not-member" ? (
				<p role="alert" className={ENTER_CLASS}>
					<Trans>You are not a member of {organizationName}, so you cannot sign the Job Clipper in to it.</Trans>
				</p>
			) : null}
			{state === "approved" ? (
				<p role="status" className={ENTER_CLASS}>
					<Trans>
						The Job Clipper is signed in to {organizationName}. You can close this tab and go back to the extension.
					</Trans>
				</p>
			) : null}
			{state === "denied" ? (
				<p role="status" className={ENTER_CLASS}>
					<Trans>You denied this sign-in. Nothing was shared. You can close this tab.</Trans>
				</p>
			) : null}
			{state === "pending" ? (
				<div className={cn(ENTER_CLASS, "space-y-4")}>
					<p className="text-sm">
						<Trans>Job Clipper on {organizationName} can read your profile name and save jobs to your tracker.</Trans>
					</p>
					<div className="space-y-1 text-center">
						<p className="text-xs text-ink-3">
							<Trans>Only continue if this code matches the one shown in the extension.</Trans>
						</p>
						<p className="font-mono text-2xl tracking-widest" data-testid="device-user-code">
							{userCode.toUpperCase()}
						</p>
					</div>
					{error && (
						<p role="alert" className={cn(ENTER_CLASS, "text-sm text-danger-text")}>
							{error}
						</p>
					)}
					<div className="flex gap-2">
						<Button className="flex-1" variant="secondary" disabled={pending} onClick={() => void submit("deny")}>
							<Trans>Deny</Trans>
						</Button>
						<Button className="flex-1" disabled={pending} onClick={() => void submit("approve")}>
							<Trans>Approve</Trans>
						</Button>
					</div>
				</div>
			) : null}
		</>
	);
}
