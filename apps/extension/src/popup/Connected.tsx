import type { Connection } from "../lib/storage";
import { Button } from "@reactive-resume/ui/components/button";
import { readableForeground } from "@reactive-resume/utils/brand";
import { clearConnection } from "../lib/storage";
import { OrgMark } from "./OrgMark";
import { strings } from "./strings";

type ConnectedProps = {
	connection: Connection;
	onDisconnected: () => void;
};

/** Connected, not signed in. T02 replaces the disabled button with the sign-in flow; T03 fills the clip view. */
export function Connected(props: ConnectedProps) {
	const { connection } = props;
	// The header takes the organization's colour; the text on it is whichever of white and black reads better.
	const headerStyle = connection.primaryColor
		? { backgroundColor: connection.primaryColor, color: readableForeground(connection.primaryColor) }
		: undefined;

	async function change() {
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
				</div>
			</header>

			<main className="flex flex-col gap-4 p-4">
				<section className="flex flex-col gap-2" aria-label={strings.signInPlaceholder}>
					<Button disabled>{strings.signInPlaceholder}</Button>
					<p className="text-xs leading-4 text-ink-3">{strings.signInNote}</p>
				</section>

				<section className="rounded-lg border border-dashed border-line-2 p-3" aria-label={strings.clipTitle}>
					<h2 className="text-sm font-semibold text-ink">{strings.clipTitle}</h2>
					<p className="mt-1 text-[13px] leading-[19px] text-ink-2">{strings.clipPlaceholder}</p>
				</section>

				<Button variant="ghost" size="sm" className="self-start" onClick={() => void change()}>
					{strings.changeOrganization}
				</Button>
			</main>
		</div>
	);
}
