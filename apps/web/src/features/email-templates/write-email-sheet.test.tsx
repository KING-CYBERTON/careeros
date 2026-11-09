// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BUILT_IN_TEMPLATES } from "@careeros/email-templates";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WriteEmailSheet } from "./write-email-sheet";

type Input = { templateId: string; applicationId: string; locale?: string; source?: { subject: string; body: string } };
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	render: vi.fn(),
	create: vi.fn(),
	toast: vi.fn(),
}));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		emailTemplates: {
			key: () => ["emailTemplates"],
			list: { queryOptions: () => ({ queryKey: ["emailTemplates", "list"], queryFn: mocks.list }) },
			render: {
				queryOptions: ({ input }: { input: Input }) => ({
					queryKey: ["emailTemplates", "render", input],
					queryFn: () => mocks.render(input),
				}),
			},
			create: { mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.create }) },
		},
	},
}));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: mocks.toast } }));

const builtIn = (kind: string, stages: string[], name: string) => ({
	id: `builtin:${kind}`,
	source: "builtin",
	kind,
	stageCategories: stages,
	name,
	subject: `Subject ${kind}`,
	body: `Body ${kind}`,
});
const LIST = [
	builtIn("follow_up", ["applied", "screening"], "Follow up after applying"),
	builtIn("thank_you", ["interview", "screening"], "Thank you after an interview"),
	builtIn("networking", ["saved"], "Reach out to someone at the company"),
	builtIn("negotiation", ["offer"], "Respond to an offer"),
];

const thankYou = BUILT_IN_TEMPLATES.find((item) => item.kind === "thank_you");
const application = { id: "app-1", company: "Acme", role: "Designer", status: "interview" } as never;

function open(status = "interview") {
	i18n.load("en", {});
	i18n.activate("en");
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	const wrap = (children: ReactNode) => (
		<QueryClientProvider client={client}>
			<I18nProvider i18n={i18n}>{children}</I18nProvider>
		</QueryClientProvider>
	);
	return render(
		wrap(<WriteEmailSheet application={{ ...(application as object), status } as never} open onOpenChange={vi.fn()} />),
	);
}

const filled = (templateId: string) => ({
	subject: `Thank you & more (${templateId})`,
	body: "Hello Sam,\nThanks for your time.",
	to: "sam@acme.test",
	missing: [],
});

beforeEach(() => {
	mocks.list.mockResolvedValue(LIST);
	mocks.render.mockImplementation(async (input: Input) => filled(input.templateId));
});
afterEach(() => vi.resetAllMocks());

it("opens on the template that suits the stage, filled in from the application", async () => {
	open("interview");
	const subject = await screen.findByLabelText("Subject");
	expect((subject as HTMLInputElement).value).toBe("Thank you & more (builtin:thank_you)");
	expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Hello Sam,\nThanks for your time.");
	expect(screen.getByTestId("write-email-to").textContent).toContain("sam@acme.test");
	// Only the templates for the stage are offered until the person asks for all.
	const options = [...(screen.getByLabelText("Template") as HTMLSelectElement).options].map((option) => option.value);
	expect(options).toEqual(["builtin:thank_you"]);
	// The built-in is rendered from the text the screen shows (so it is filled in in the person's language).
	expect(mocks.render).toHaveBeenCalledWith(
		expect.objectContaining({
			templateId: "builtin:thank_you",
			applicationId: "app-1",
			source: { subject: thankYou?.subject, body: thankYou?.body },
		}),
	);
});

it("puts the contact's address and the filled subject and body in the mailto link", async () => {
	open("interview");
	const link = await screen.findByTestId("write-email-open-mail");
	expect(link.getAttribute("href")).toBe(
		"mailto:sam@acme.test?subject=Thank%20you%20%26%20more%20(builtin%3Athank_you)&body=Hello%20Sam%2C%0D%0AThanks%20for%20your%20time.",
	);
});

it("carries the person's edits into the link, and starts afresh on another template", async () => {
	open("interview");
	const subject = (await screen.findByLabelText("Subject")) as HTMLInputElement;
	fireEvent.change(subject, { target: { value: "My own subject" } });
	await waitFor(() =>
		expect(screen.getByTestId("write-email-open-mail").getAttribute("href")).toContain("subject=My%20own%20subject"),
	);
	fireEvent.click(screen.getByRole("checkbox", { name: "Show templates for every stage" }));
	fireEvent.change(screen.getByLabelText("Template"), { target: { value: "builtin:follow_up" } });
	await waitFor(() =>
		expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Thank you & more (builtin:follow_up)"),
	);
});

it("copies the subject and the body", async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	open("interview");
	await screen.findByLabelText("Subject");
	fireEvent.click(screen.getByRole("button", { name: "Copy" }));
	await waitFor(() =>
		expect(writeText).toHaveBeenCalledWith("Thank you & more (builtin:thank_you)\n\nHello Sam,\nThanks for your time."),
	);
	expect(mocks.toast).toHaveBeenCalledWith({ description: "Email copied" });
});

it("copies instead when the link would be longer than 1 800 characters", async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	mocks.render.mockImplementation(async (input: Input) => ({ ...filled(input.templateId), body: "word ".repeat(600) }));
	open("interview");
	await screen.findByLabelText("Subject");
	expect(screen.queryByTestId("write-email-open-mail")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Open in mail app" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
	expect(mocks.toast).toHaveBeenCalledWith({
		description: "This email is too long to open in your mail app, so it was copied instead.",
	});
});

it("leaves the recipient out when the contact has no address, and warns about unfilled parts", async () => {
	mocks.render.mockImplementation(async () => ({
		subject: "Hello [contactName]",
		body: "Dear [contactName]",
		to: null,
		missing: ["contactName"],
	}));
	open("interview");
	const link = await screen.findByTestId("write-email-open-mail");
	expect(link.getAttribute("href")?.startsWith("mailto:?subject=")).toBe(true);
	expect(screen.getByText(/Fill in the \[bracketed\] parts/)).toBeTruthy();
});

it("saves the text as it reads as a template of the person's own", async () => {
	mocks.create.mockResolvedValue({});
	open("interview");
	await screen.findByLabelText("Subject");
	fireEvent.click(screen.getByRole("button", { name: "Save as my template" }));
	const name = await screen.findByLabelText("Name");
	expect((name as HTMLInputElement).value).toBe("Thank you after an interview (mine)");
	fireEvent.click(screen.getByRole("button", { name: "Save template" }));
	await waitFor(() =>
		expect(mocks.create).toHaveBeenCalledWith(
			{
				kind: "thank_you",
				stageCategory: "interview",
				name: "Thank you after an interview (mine)",
				subject: "Thank you & more (builtin:thank_you)",
				body: "Hello Sam,\nThanks for your time.",
			},
			expect.anything(),
		),
	);
});

it("offers every template for a stage with no suggestion", async () => {
	open("closed");
	await screen.findByLabelText("Subject");
	expect((screen.getByLabelText("Template") as HTMLSelectElement).options).toHaveLength(4);
});
