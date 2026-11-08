import type { BillingProvider } from "./types";
import { createFakeProvider, type SignedFakeEvent } from "./fake";
import { manualProvider } from "./manual";

// CAREEROS (P3-T04): picks the adapter for the BILLING_PROVIDER setting. `paystack` and `stripe` are accepted settings
// whose adapters arrive with P3-T05; until then they resolve to no provider, like `none`.

export type BillingProviderSetting = "fake" | "paystack" | "stripe" | "none";

export type BillingProviderConfig = {
	provider: BillingProviderSetting;
	fakeSecret?: string | undefined;
	/** The platform's public address (APP_URL). */
	appUrl: string;
	/** Delivers an event the fake provider signed to the webhook intake (set by the server's wiring). */
	emitFake?: (event: SignedFakeEvent) => Promise<void>;
};

/** The configured adapter, or null when billing is off or the adapter does not exist yet. */
export function resolveBillingProvider(config: BillingProviderConfig): BillingProvider | null {
	if (config.provider === "fake") {
		if (!config.fakeSecret) throw new Error("BILLING_PROVIDER=fake requires BILLING_FAKE_SECRET.");
		return createFakeProvider({
			secret: config.fakeSecret,
			appUrl: config.appUrl,
			...(config.emitFake && { emit: config.emitFake }),
		});
	}
	return null;
}

export { manualProvider };
export {
	createFakeProvider,
	fakeDecisionEvent,
	FAKE_SIGNATURE_HEADER,
	newFakeEventId,
	readFakeSession,
	signFakeEvent,
	signFakeSession,
	type FakeCheckoutSession,
	type FakeEventBody,
	type FakeProviderOptions,
	type SignedFakeEvent,
} from "./fake";
export {
	ProviderUnsupportedError,
	type BillingProvider,
	type CancelInput,
	type ChangeSeatsInput,
	type CheckoutInput,
	type CheckoutResult,
	type PortalInput,
} from "./types";
