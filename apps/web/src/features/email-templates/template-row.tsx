import type { TemplateEntry } from "./queries";
import type { ReactNode } from "react";
import { Badge } from "@reactive-resume/ui/components/badge";
import { getKindLabel, getSourceLabel } from "./labels";
import { getStageLabel } from "@/features/applications/stages";

type TemplateRowProps = {
	entry: TemplateEntry;
	/** Buttons at the right of the row. */
	children?: ReactNode;
};

/** CAREEROS (P5-T04): one template in a list: its name, kind, source and the stages it is suggested for. */
export function TemplateRow({ entry, children }: TemplateRowProps) {
	const stages = entry.stageCategories.map((stage) => getStageLabel(stage)).join(", ");
	return (
		<li className="flex flex-wrap items-center gap-3 p-3" data-testid="email-template-row">
			<div className="grid min-w-0 flex-1 gap-0.5">
				<span className="truncate text-sm font-medium">{entry.name}</span>
				<span className="truncate text-[13px] text-ink-3">{entry.subject}</span>
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge>{getKindLabel(entry.kind)}</Badge>
				<Badge>{getSourceLabel(entry.source)}</Badge>
				{stages && <span className="text-xs text-ink-3">{stages}</span>}
			</div>
			{children}
		</li>
	);
}
