// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BUILT_IN_TEMPLATES } from "@careeros/email-templates";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EmailTemplatesSettings } from "./my-templates-page";
import { OrgEmailTemplatesSettings } from "./org-templates-page";

const mocks = vi.hoisted(() => ({
	mutation: (fn: () => unknown) => ({
		mutationOptions: (options: object) => ({ ...options, mutationFn: fn }),
	}),
	list: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	archive: vi.fn(),
	orgCreate: vi.fn(),
	orgUpdate: vi.fn(),
	orgArchive: vi.fn(),
	toast: vi.fn(),
	confirm: vi.fn(),
}));
vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		emailTemplates: {
			key: () => ["emailTemplates"],
			list: { queryOptions: () => ({ queryKey: ["emailTemplates", "list"], queryFn: mocks.list }) },
			create: mocks.mutation(mocks.create),
			update: mocks.mutation(mocks.update),
			archive: mocks.mutation(mocks.archive),
			orgCreate: mocks.mutation(mocks.orgCreate),
			orgUpdate: mocks.mutation(mocks.orgUpdate),
			orgArchive: mocks.mutation(mocks.orgArchive),
		},
	},
}));
vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: mocks.toast } }));
vi.mock("@/hooks/use-confirm", () => ({ useConfirm: () => mocks.confirm }));
vi.mock("@/features/org-admin/access", () => ({ RequireOrgAdmin: ({ children }: { children: unknown }) => children }));

const builtIns = BUILT_IN_TEMPLATES.map((item) => ({
	id: item.id,
	source: "builtin",
	kind: item.kind,
	stageCategories: [...item.stageCategories],
	name: item.name,
	subject: item.subject,
	body: item.body,
}));
const stored = (id: string, source: "org" | "mine", name: string, kind = "custom") => ({
	id,
	source,
	kind,
	stageCategories: [] as string[],
	name,
	subject: `${name} subject`,
	body: `${name} body`,
});

function show(ui: React.ReactElement) {
	i18n.load("en", {});
	i18n.activate("en");
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<I18nProvider i18n={i18n}>{ui}</I18nProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => mocks.confirm.mockResolvedValue(true));
afterEach(() => vi.resetAllMocks());

it("org admin: customising a built-in starts from its text and saves an organization default", async () => {
	mocks.list.mockResolvedValue([...builtIns, stored("m1", "mine", "Only mine")]);
	mocks.orgCreate.mockResolvedValue({});
	show(<OrgEmailTemplatesSettings />);
	const rows = await screen.findAllByTestId("email-template-row");
	// The admin's own templates are not part of the organization's list.
	expect(rows).toHaveLength(4);
	const followUp = rows.find((row) => within(row).queryByText("Follow up after applying"));
	if (!followUp) throw new Error("no follow-up row");
	fireEvent.click(within(followUp).getByRole("button", { name: "Customise Follow up after applying" }));
	const subject = (await screen.findByLabelText("Subject")) as HTMLInputElement;
	const original = BUILT_IN_TEMPLATES.find((item) => item.kind === "follow_up");
	expect(subject.value).toBe(original?.subject);
	expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(original?.body);
	fireEvent.change(subject, { target: { value: "Our own subject {{role}}" } });
	fireEvent.click(screen.getByRole("button", { name: "Save template" }));
	await waitFor(() =>
		expect(mocks.orgCreate).toHaveBeenCalledWith(
			{
				kind: "follow_up",
				stageCategory: "applied",
				name: "Follow up after applying",
				subject: "Our own subject {{role}}",
				body: original?.body,
			},
			expect.anything(),
		),
	);
});

it("org admin: edits and archives a default, with a confirmation that names the fall back", async () => {
	mocks.list.mockResolvedValue([stored("o1", "org", "Our follow-up", "follow_up"), ...builtIns.slice(1)]);
	mocks.orgUpdate.mockResolvedValue({});
	mocks.orgArchive.mockResolvedValue({ id: "o1" });
	show(<OrgEmailTemplatesSettings />);
	await screen.findByText("Our follow-up");
	fireEvent.click(screen.getByRole("button", { name: "Edit Our follow-up" }));
	fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Renamed" } });
	fireEvent.click(screen.getByRole("button", { name: "Save template" }));
	await waitFor(() =>
		expect(mocks.orgUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ id: "o1", name: "Renamed" }),
			expect.anything(),
		),
	);
	fireEvent.click(screen.getByRole("button", { name: "Archive Our follow-up" }));
	await waitFor(() => expect(mocks.orgArchive).toHaveBeenCalledWith({ id: "o1" }, expect.anything()));
	expect(mocks.confirm).toHaveBeenCalledWith(
		"Archive Our follow-up?",
		expect.objectContaining({ description: "Members see the built-in template again instead." }),
	);
});

it("member: lists their own templates with edit and archive, and the others read-only", async () => {
	mocks.list.mockResolvedValue([stored("m1", "mine", "My note"), stored("o1", "org", "School note"), ...builtIns]);
	mocks.update.mockResolvedValue({});
	mocks.archive.mockResolvedValue({ id: "m1" });
	show(<EmailTemplatesSettings />);
	await screen.findByText("My note");
	expect(screen.getByText("School note")).toBeTruthy();
	// Only the member's own template can be edited or archived.
	expect(screen.getAllByRole("button", { name: /^(Edit|Archive) / })).toHaveLength(2);
	fireEvent.click(screen.getByRole("button", { name: "Edit My note" }));
	fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "New text" } });
	fireEvent.click(screen.getByRole("button", { name: "Save template" }));
	await waitFor(() =>
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({ id: "m1", body: "New text" }),
			expect.anything(),
		),
	);
	fireEvent.click(screen.getByRole("button", { name: "Archive My note" }));
	await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith({ id: "m1" }, expect.anything()));
});

it("member: a new template needs a name and a subject", async () => {
	mocks.list.mockResolvedValue(builtIns);
	mocks.create.mockResolvedValue({});
	show(<EmailTemplatesSettings />);
	await screen.findByText("You have no templates of your own yet. You can also save one from Write email.");
	fireEvent.click(screen.getByRole("button", { name: "New template" }));
	const save = await screen.findByRole("button", { name: "Save template" });
	expect((save as HTMLButtonElement).disabled).toBe(true);
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Reference request" } });
	fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Could you be a reference?" } });
	expect((save as HTMLButtonElement).disabled).toBe(false);
	fireEvent.click(save);
	await waitFor(() =>
		expect(mocks.create).toHaveBeenCalledWith(
			{
				kind: "custom",
				stageCategory: null,
				name: "Reference request",
				subject: "Could you be a reference?",
				body: "",
			},
			expect.anything(),
		),
	);
});
