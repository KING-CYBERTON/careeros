import { createFileRoute } from "@tanstack/react-router";
import { HandoffRedeemPage } from "@/features/auth/pages/handoff-redeem";

// CAREEROS (P2-T05): the organization host's half of the sign-in handoff. Reachable without a session.
export const Route = createFileRoute("/auth/handoff/redeem")({
	component: HandoffRedeemPage,
});
