// CAREEROS (P6-T01, G10): renders one legal draft from docs/legal, with the draft banner until the texts are approved.
import { Trans } from "@lingui/react/macro";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Alert, AlertDescription, AlertTitle } from "@reactive-resume/ui/components/alert";
import { LEGAL_PAGES_APPROVED } from "./constants";
import { legalDocuments, type LegalDocumentId } from "./documents";

type LegalPageProps = {
	document: LegalDocumentId;
	/** Defaults to the code constant; tests pass it to check both states. */
	approved?: boolean;
};

export function LegalPage({ document, approved = LEGAL_PAGES_APPROVED }: LegalPageProps) {
	return (
		<main id="main-content" className="container mx-auto max-w-3xl px-6 pt-28 pb-16">
			{approved ? null : (
				<Alert className="mb-8" data-testid="legal-draft-banner">
					<AlertTitle>
						<Trans>Draft for review. Not legal advice. Not in force until approved.</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>Parts marked [TO CONFIRM] are still to be decided.</Trans>
					</AlertDescription>
				</Alert>
			)}
			<p className="mb-6 text-sm text-ink-3">
				<Trans>The legal texts are available in English only for now.</Trans>
			</p>
			<div className="typeset">
				<ReactMarkdown
					skipHtml
					remarkPlugins={[remarkGfm]}
					components={{
						table: ({ children }) => (
							<div className="typeset-scroll">
								<table>{children}</table>
							</div>
						),
						img: ({ alt }) => alt ?? null,
					}}
				>
					{legalDocuments[document]}
				</ReactMarkdown>
			</div>
		</main>
	);
}
