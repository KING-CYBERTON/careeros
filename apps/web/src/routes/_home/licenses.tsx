// CAREEROS: public open-source licenses page. Shows the MIT notice from NOTICE, upstream copyright line verbatim.
import { t } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";
import { NOTICE_ENTRIES, NOTICE_INTRO } from "@reactive-resume/utils/notice";
import { getBrand } from "@/libs/brand";

export const Route = createFileRoute("/_home/licenses")({
	component: LicensesPage,
	head: () => ({ meta: [{ title: `${t`Open-source licenses`} | ${getBrand().appName}` }] }),
});

function LicensesPage() {
	return (
		<main id="main-content" className="container mx-auto max-w-3xl px-6 pt-28 pb-16">
			<h1 className="mb-6 text-3xl font-semibold tracking-tight">{t`Open-source licenses`}</h1>
			<pre className="mb-10 text-sm leading-relaxed whitespace-pre-wrap">{NOTICE_INTRO}</pre>
			{NOTICE_ENTRIES.map((entry) => (
				<section key={entry.name} className="mb-10">
					<h2 className="text-xl font-semibold">{entry.name}</h2>
					<a href={entry.url} className="text-sm underline underline-offset-4" rel="noopener noreferrer">
						{entry.url}
					</a>
					<pre className="mt-4 text-sm leading-relaxed whitespace-pre-wrap">{entry.license}</pre>
				</section>
			))}
		</main>
	);
}
