import { useState } from "react";
import { cn } from "@reactive-resume/utils/style";
import { strings } from "./strings";

type OrgMarkProps = {
	orgName: string;
	/** Already checked: on the organization's own origin, over https. */
	logoUrl: string | null;
	className?: string;
};

/** The organization's logo, or its first letter when there is none or it does not load. */
export function OrgMark(props: OrgMarkProps) {
	const [failed, setFailed] = useState(false);
	const shared = "shrink-0 rounded-md";
	if (props.logoUrl && !failed) {
		return (
			<img
				src={props.logoUrl}
				alt={strings.logoAlt(props.orgName)}
				referrerPolicy="no-referrer"
				className={cn(shared, "bg-raised object-contain", props.className)}
				onError={() => setFailed(true)}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				shared,
				"flex items-center justify-center bg-accent-soft text-lg font-semibold text-accent-text",
				props.className,
			)}
		>
			{[...props.orgName][0]?.toUpperCase() ?? ""}
		</span>
	);
}
