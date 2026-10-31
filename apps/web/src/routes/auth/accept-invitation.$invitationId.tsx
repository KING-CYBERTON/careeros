import { createFileRoute } from "@tanstack/react-router";
import { AcceptInvitationPage } from "@/features/auth/pages/accept-invitation";

// CAREEROS: the invitation email links here (P1-T03)
export const Route = createFileRoute("/auth/accept-invitation/$invitationId")({
	component: RouteComponent,
});

function RouteComponent() {
	const { invitationId } = Route.useParams();
	return <AcceptInvitationPage invitationId={invitationId} />;
}
