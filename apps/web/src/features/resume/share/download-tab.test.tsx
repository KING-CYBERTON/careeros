// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { DownloadTab } from "./download-tab";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), download: vi.fn(), toast: vi.fn() }));
vi.mock("@/features/resume/builder/draft", () => ({ useCurrentResume: () => ({ id: "resume" }) }));
vi.mock("@/features/resume/editor/check/use-check", () => ({ useOpenIssueCount: () => 0 }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [] }) }));
vi.mock("@/features/applications/queries", () => ({ applicationsListQueryOptions: () => ({}) }));
vi.mock("@/features/letters/export", () => ({ createLetterFile: vi.fn(), letterFileName: vi.fn() }));
vi.mock("@/libs/orpc/client", () => ({ client: {} }));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: mocks.toast } }));
vi.mock("@reactive-resume/utils/file", () => ({ downloadWithAnchor: mocks.download }));
vi.mock("@/features/resume/export/use-resume-export", () => ({
	createExportFile: mocks.generate,
	getDefaultFileName: () => "resume",
	preloadDocumentExport: () => undefined,
	sanitizeFileName: (value: string) => value,
}));

// CAREEROS: the upstream community feedback and donation prompts are gone (P2-T08); a successful export shows neither.
it("never shows community or donation prompts, after a successful export or a failure", async () => {
	i18n.load("en", {});
	i18n.activate("en");
	const file = new Blob(["fictional resume"]);
	let finish!: (file: Blob) => void;
	mocks.generate.mockReturnValueOnce(new Promise<Blob>((resolve) => (finish = resolve)));
	render(
		<I18nProvider i18n={i18n}>
			<DownloadTab onReview={() => undefined} />
		</I18nProvider>,
	);
	const prompts = () => [
		screen.queryByRole("link", { name: /Discord/ }),
		screen.queryByRole("link", { name: "Donate" }),
	];
	expect(prompts()).toEqual([null, null]);
	fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
	finish(file);
	await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledWith(file, "resume.pdf"));
	expect(prompts()).toEqual([null, null]);

	fireEvent.click(screen.getByRole("radio", { name: /Word/ }));
	mocks.generate.mockRejectedValueOnce(new Error("Export unavailable"));
	fireEvent.click(screen.getByRole("button", { name: "Download Word" }));
	await screen.findByRole("alert");
	expect(prompts()).toEqual([null, null]);
	expect(screen.queryByText(/Reactive Resume/)).toBeNull();
});
