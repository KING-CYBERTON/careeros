import { createFileRoute } from "@tanstack/react-router";
import { ImpersonateRedeemPage } from "@/features/auth/pages/impersonate-redeem";

// CAREEROS (P3-T07): the member host's half of a support session. Reachable without a session.
export const Route = createFileRoute("/auth/impersonate")({
	component: ImpersonateRedeemPage,
});
