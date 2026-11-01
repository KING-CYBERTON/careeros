import { createFileRoute } from "@tanstack/react-router";
import z from "zod";
import { HandoffPage } from "@/features/auth/pages/handoff";

// CAREEROS (P2-T05): the platform host's half of the sign-in handoff. Reachable without a session.
export const Route = createFileRoute("/auth/handoff/")({
	component: RouteComponent,
	validateSearch: z.object({ request: z.string().max(128).catch("") }),
});

function RouteComponent() {
	const { request } = Route.useSearch();
	return <HandoffPage requestId={request} />;
}
