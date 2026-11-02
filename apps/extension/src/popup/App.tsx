import type { Connection } from "../lib/storage";
import { useEffect, useState } from "react";
import { accentTokens } from "@reactive-resume/utils/brand";
import { DEV_HTTP_HOSTS } from "../lib/config";
import { loadConnection } from "../lib/storage";
import { Connected } from "./Connected";
import { Setup } from "./Setup";
import { strings } from "./strings";

type State = { kind: "loading" } | { kind: "setup" } | { kind: "connected"; connection: Connection };

/** The accent tokens of the organization's primary colour, set as variables on the popup root. */
function brandVariables(primary: string | null): React.CSSProperties | undefined {
	if (!primary) return undefined;
	const { accent, accentHover, onAccent, accentSoft, accentText } = accentTokens(primary).light;
	return {
		"--accent": accent,
		"--accent-hover": accentHover,
		"--on-accent": onAccent,
		"--accent-soft": accentSoft,
		"--accent-text": accentText,
	} as React.CSSProperties;
}

export function App() {
	const [state, setState] = useState<State>({ kind: "loading" });

	useEffect(() => {
		let active = true;
		loadConnection(DEV_HTTP_HOSTS)
			.then((connection) => {
				if (active) setState(connection ? { kind: "connected", connection } : { kind: "setup" });
			})
			.catch(() => {
				if (active) setState({ kind: "setup" });
			});
		return () => {
			active = false;
		};
	}, []);

	const connection = state.kind === "connected" ? state.connection : null;

	return (
		<div className="w-[360px] bg-bg text-ink" style={brandVariables(connection?.primaryColor ?? null)}>
			{state.kind === "loading" ? <p className="p-4 text-sm text-ink-2">{strings.loading}</p> : null}
			{state.kind === "setup" ? (
				<Setup onConnected={(next) => setState({ kind: "connected", connection: next })} />
			) : null}
			{state.kind === "connected" ? (
				<Connected connection={state.connection} onDisconnected={() => setState({ kind: "setup" })} />
			) : null}
		</div>
	);
}
