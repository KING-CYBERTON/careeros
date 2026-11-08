import type { DeviceFlow } from "../lib/device-flow";
import type { Session } from "../lib/session";
import type { Connection } from "../lib/storage";
import { useEffect, useState } from "react";
import { Alert } from "@reactive-resume/ui/components/alert";
import { Button } from "@reactive-resume/ui/components/button";
import { readableForeground } from "@reactive-resume/utils/brand";
import { DEV_HTTP_HOSTS } from "../lib/config";
import { approvalUrl, formatUserCode, nextPollDelaySeconds, pollDeviceFlow, startDeviceFlow } from "../lib/device-flow";
import { callApi, clearFlow, clearSession, loadFlow, loadSession, saveFlow, saveSession } from "../lib/session";
import { clearConnection } from "../lib/storage";
import { OrgMark } from "./OrgMark";
import { strings } from "./strings";

type ConnectedProps = {
	connection: Connection;
	onDisconnected: () => void;
};

/** Connected: signed out (a Sign in button), waiting for approval (the code), or signed in. T03 fills the clip view. */
export function Connected(props: ConnectedProps) {
	const { connection } = props;
	const [session, setSession] = useState<Session | null>(null);
	const [flow, setFlow] = useState<DeviceFlow | null>(null);
	const [ready, setReady] = useState(false);
	const [starting, setStarting] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	// The header takes the organization's colour; the text on it is whichever of white and black reads better.
	const headerStyle = connection.primaryColor
		? { backgroundColor: connection.primaryColor, color: readableForeground(connection.primaryColor) }
		: undefined;

	// On open: restore a stored sign-in or a flow that was waiting, and check the sign-in is still good.
	useEffect(() => {
		let active = true;
		void (async () => {
			const [storedSession, storedFlow] = await Promise.all([loadSession(DEV_HTTP_HOSTS), loadFlow(DEV_HTTP_HOSTS)]);
			if (!active) return;
			// A sign-in or a flow for another organization than the connected one is never used.
			if (storedFlow && storedFlow.origin !== connection.origin) await clearFlow();
			if (storedSession && storedSession.origin !== connection.origin) await clearSession();
			const own = storedSession && storedSession.origin === connection.origin ? storedSession : null;
			if (own) {
				setSession(own);
				const me = await callApi<{ name?: string }>(own, connection.origin, "/api/openapi/clipper/whoami");
				if (!active) return;
				if (!me.ok && me.reason === "unauthorized") {
					// The server no longer knows this token (revoked, expired, member removed): back to "not signed in".
					await clearSession();
					setSession(null);
					setNotice(strings.sessionEnded);
				} else if (me.ok && typeof me.data?.name === "string" && me.data.name !== own.userName) {
					const next = { ...own, userName: me.data.name.slice(0, 120) };
					await saveSession(next);
					setSession(next);
				}
			} else if (storedFlow && storedFlow.origin === connection.origin) {
				setFlow(storedFlow);
			}
			setReady(true);
		})();
		return () => {
			active = false;
		};
	}, [connection.origin]);

	// While a flow waits, poll at the server's interval, 5 seconds slower after each `slow_down`.
	useEffect(() => {
		if (!flow) return;
		let active = true;
		let slowDowns = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = async (message: string | null) => {
			await clearFlow();
			if (!active) return;
			setFlow(null);
			setNotice(message);
		};
		const tick = async () => {
			const result = await pollDeviceFlow(flow);
			if (!active) return;
			if (result.kind === "approved") {
				const next: Session = { origin: flow.origin, token: result.token, userName: result.userName };
				await saveSession(next);
				await clearFlow();
				if (!active) return;
				setFlow(null);
				setNotice(null);
				setSession(next);
				return;
			}
			if (result.kind === "denied") return void (await finish(strings.signInDenied));
			if (result.kind === "expired") return void (await finish(strings.signInExpired));
			if (result.kind === "failed") return void (await finish(strings.signInError));
			if (result.kind === "slow_down") slowDowns += 1;
			timer = setTimeout(() => void tick(), nextPollDelaySeconds(flow.interval, slowDowns) * 1000);
		};
		timer = setTimeout(() => void tick(), nextPollDelaySeconds(flow.interval, 0) * 1000);
		return () => {
			active = false;
			if (timer) clearTimeout(timer);
		};
	}, [flow]);

	async function signIn() {
		setStarting(true);
		setNotice(null);
		const started = await startDeviceFlow(connection.origin);
		setStarting(false);
		if (!started.ok) {
			setNotice(started.reason === "unsupported" ? strings.signInUnsupported : strings.signInFailed);
			return;
		}
		await saveFlow(started.flow);
		setFlow(started.flow);
	}

	async function cancel() {
		await clearFlow();
		setFlow(null);
	}

	/** Revokes the token on the server, then forgets it. A server that cannot be reached does not keep the token here. */
	async function endSession(current: Session) {
		await callApi(current, connection.origin, "/api/auth/device/clipper/revoke", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		await clearSession();
		setSession(null);
	}

	async function signOut() {
		if (session) await endSession(session);
	}

	async function change() {
		if (session) await endSession(session);
		await clearConnection(connection.origin);
		props.onDisconnected();
	}

	return (
		<div className="flex flex-col">
			<header
				className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 text-ink"
				style={headerStyle}
			>
				<OrgMark orgName={connection.orgName} logoUrl={connection.logoUrl} className="size-10" />
				<div className="min-w-0">
					<p className="text-xs opacity-80">{strings.connectedTo}</p>
					<h1 className="truncate text-base font-semibold">{connection.orgName}</h1>
					{session ? (
						<p className="truncate text-xs opacity-80" data-testid="signed-in-as">
							{session.userName ? strings.signedInAs(session.userName) : strings.signedInAsYou}
						</p>
					) : null}
				</div>
			</header>

			<main className="flex flex-col gap-4 p-4">
				{notice ? <Alert>{notice}</Alert> : null}

				{ready && !session && !flow ? (
					<section className="flex flex-col gap-2" aria-label={strings.signIn}>
						<Button disabled={starting} onClick={() => void signIn()}>
							{starting ? strings.signingIn : strings.signIn}
						</Button>
						<p className="text-xs leading-4 text-ink-3">{strings.signInNote}</p>
					</section>
				) : null}

				{flow ? (
					<section className="flex flex-col gap-3" aria-label={strings.signInTitle}>
						<h2 className="text-sm font-semibold text-ink">{strings.signInTitle}</h2>
						<p className="text-[13px] leading-[19px] text-ink-2">{strings.signInSteps}</p>
						<div className="rounded-lg border border-line-2 p-3 text-center">
							<p className="text-xs text-ink-3">{strings.yourCode}</p>
							<p className="font-mono text-2xl tracking-widest text-ink" data-testid="user-code">
								{formatUserCode(flow.userCode)}
							</p>
						</div>
						<Button onClick={() => void chrome.tabs.create({ url: approvalUrl(flow.origin, flow.userCode) })}>
							{strings.openApproval}
						</Button>
						<p className="text-xs text-ink-3" role="status">
							{strings.waitingForApproval}
						</p>
						<Button variant="ghost" size="sm" className="self-start" onClick={() => void cancel()}>
							{strings.cancel}
						</Button>
					</section>
				) : null}

				{session ? (
					<section className="rounded-lg border border-dashed border-line-2 p-3" aria-label={strings.clipTitle}>
						<h2 className="text-sm font-semibold text-ink">{strings.clipTitle}</h2>
						<p className="mt-1 text-[13px] leading-[19px] text-ink-2">{strings.clipPlaceholder}</p>
					</section>
				) : null}

				<div className="flex items-center justify-between">
					<Button variant="ghost" size="sm" onClick={() => void change()}>
						{strings.changeOrganization}
					</Button>
					{session ? (
						<Button variant="ghost" size="sm" onClick={() => void signOut()}>
							{strings.signOut}
						</Button>
					) : null}
				</div>
			</main>
		</div>
	);
}
