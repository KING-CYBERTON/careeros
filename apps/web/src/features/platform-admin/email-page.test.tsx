// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

// CAREEROS (P6-T02): the console's "Send test email" has no recipient field, sends with an empty input and shows the
// provider's answer: queued, or the error code.

const state = vi.hoisted(() => ({ answer: undefined as unknown, calls: [] as unknown[] }));

vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		admin: {
			email: {
				sendTest: {
					mutationOptions: (options: object) => ({
						...options,
						mutationFn: async (input: unknown) => {
							state.calls.push(input);
							return state.answer;
						},
					}),
				},
			},
		},
	},
}));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: vi.fn() } }));

i18n.loadAndActivate({ locale: "en", messages: {} });

const { EmailPage } = await import("./email-page");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const view = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
			<I18nProvider i18n={i18n}>
				<EmailPage />
			</I18nProvider>
		</QueryClientProvider>,
	);

afterEach(() => {
	cleanup();
	state.calls = [];
});

it("has no recipient field", () => {
	view();
	expect(screen.queryAllByRole("textbox")).toHaveLength(0);
	expect(screen.getByTestId("email-test-send")).toBeTruthy();
});

it("sends with an empty input and shows queued", async () => {
	state.answer = { provider: "plunk", outcome: "queued" };
	view();
	fireEvent.click(screen.getByTestId("email-test-send"));
	await waitFor(() => expect(screen.getByTestId("email-test-result").textContent).toContain("Queued"));
	expect(state.calls).toEqual([{}]);
});

it("shows the error code of a refusal", async () => {
	state.answer = { provider: "plunk", outcome: "failed", code: "plan_limit", status: 402 };
	view();
	fireEvent.click(screen.getByTestId("email-test-send"));
	await waitFor(() => expect(screen.getByTestId("email-test-result").textContent).toContain("plan_limit"));
});
