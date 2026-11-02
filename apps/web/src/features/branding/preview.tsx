import type { CSSProperties } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { brandPreviewVars, isHexColor } from "@reactive-resume/utils/brand";

// CAREEROS (P2-T07): a sample header, button and card in the brand's colours and font. It sets the same custom
// properties the server writes into the page (`renderBrandCss`), on this wrapper only, so nothing else on the page
// changes and there is no reload. The secondary colour has no UI surface yet (Q96); it shows as a chip here.

type BrandPreviewProps = {
	appName: string;
	logoUrl: string | null;
	primaryColor: string;
	secondaryColor: string;
	font: string;
};

export function BrandPreview({ appName, logoUrl, primaryColor, secondaryColor, font }: BrandPreviewProps) {
	const vars = brandPreviewVars(
		isHexColor(primaryColor.trim()) ? primaryColor.trim() : null,
		isHexColor(secondaryColor.trim()) ? secondaryColor.trim() : null,
	);
	const style = { ...vars, ...(font ? { fontFamily: `"${font}", var(--font-ui)` } : {}) } as CSSProperties;
	return (
		<div
			data-testid="brand-preview"
			style={style}
			className="overflow-hidden rounded-xl bg-bg text-ink outline outline-line"
			aria-label={t`Preview of your branding`}
			role="img"
		>
			<div className="flex items-center gap-2.5 border-b border-line bg-paper px-4 py-3">
				{logoUrl ? (
					<img src={logoUrl} alt="" className="h-6 max-w-28 object-contain" />
				) : (
					<span className="size-6 rounded-md bg-accent" aria-hidden />
				)}
				<span data-testid="brand-preview-name" className="truncate text-sm font-semibold">
					{appName}
				</span>
			</div>
			<div className="grid gap-3 p-4">
				<div className="grid gap-2 rounded-lg bg-paper p-3 outline outline-line">
					<span className="text-sm font-medium">
						<Trans>Sample card</Trans>
					</span>
					<span className="text-[13px] text-ink-3">
						<Trans>This is how buttons and highlights look.</Trans>
					</span>
					<div className="flex flex-wrap items-center gap-2">
						<span
							data-testid="brand-preview-button"
							className="inline-flex h-9 items-center rounded-lg bg-accent px-3 text-sm font-medium text-on-accent"
						>
							<Trans>Primary button</Trans>
						</span>
						<span className="inline-flex h-7 items-center rounded-md bg-accent-soft px-2 text-xs font-medium text-accent-text">
							<Trans>Highlight</Trans>
						</span>
						<span
							data-testid="brand-preview-secondary"
							className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium"
							style={{
								background: "var(--brand-secondary, var(--sunken))",
								color: "var(--brand-on-secondary, inherit)",
							}}
						>
							<Trans>Secondary</Trans>
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}
