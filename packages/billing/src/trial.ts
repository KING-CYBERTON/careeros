import { withOrgContext } from "@careeros/tenancy";
import { db } from "@reactive-resume/db/client";
import { nextState, type Transition } from "./state";
import { applyTransition, loadBillingState, lockOrganizationBilling } from "./store";

// CAREEROS (P3-T04, phase plan D3): starting a trial. A trial replaces the `personal` plan only for an organization that
// asks for one; personal organizations made at signup stay on `personal`. The caller has checked that `actorUserId` owns
// the organization. Once per organization: the trial end date stays on the subscription for good.

/** Returns the transition; `applied` is false (with a `reason`) when the organization cannot start a trial. */
export async function startTrial(orgId: string, actorUserId: string, now: Date = new Date()): Promise<Transition> {
	return await withOrgContext(orgId, () =>
		db.transaction(async () => {
			await lockOrganizationBilling(orgId);
			const transition = nextState(await loadBillingState(orgId), { type: "trial.started" }, now);
			await applyTransition(orgId, transition, { source: "trial", actorUserId, reason: "trial_started" });
			return transition;
		}),
	);
}
