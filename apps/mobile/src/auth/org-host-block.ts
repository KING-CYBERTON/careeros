import { useSyncExternalStore } from "react";

// CAREEROS (P2-T03): set when the server says the signed-in account is not a member of the organization that owns the
// server address (`ORG_HOST_NOT_MEMBER`). SessionGate shows the message and the sign-out action while it is set.
let blocked = false;
const listeners = new Set<() => void>();

const publish = (next: boolean) => {
	if (blocked === next) return;
	blocked = next;
	for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export function markOrgHostBlocked(): void {
	publish(true);
}

/** Forget the block: the account changed, so the answer may be different. */
export function clearOrgHostBlock(): void {
	publish(false);
}

export function useOrgHostBlocked(): boolean {
	return useSyncExternalStore(subscribe, () => blocked);
}
