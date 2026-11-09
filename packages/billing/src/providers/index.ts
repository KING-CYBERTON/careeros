import type { BillingProvider } from "./types";
import { createFakeProvider, type SignedFakeEvent } from "./fake";
import { manualProvider } from "./manual";
import { createPaystackProvider } from "./paystack";

// CAREEROS (P3-T04): picks the adapter for the BILLING_PROVIDER setting. `stripe` is an accepted setting with no adapter
// yet; it resolves to no provider, like `none`. `paystack` is the P3-T05 adapter.

export type BillingProviderSetting = "fake" | "paystack" | "stripe" | "none";

export type BillingProviderConfig = {
	provider: BillingProviderSetting;
	fakeSecret?: string | undefined;
	/** CAREEROS (P3-T05): the Paystack keys, set when `provider` is `paystack`. */
	paystackSecretKey?: string | undefined;
	paystackPublicKey?: string | undefined;
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
	if (config.provider === "paystack") {
		if (!config.paystackSecretKey) throw new Error("BILLING_PROVIDER=paystack requires PAYSTACK_SECRET_KEY.");
		return createPaystackProvider({
			secretKey: config.paystackSecretKey,
			...(config.paystackPublicKey && { publicKey: config.paystackPublicKey }),
		});
	}
	return null;
}

export { manualProvider };
export {
	addInterval,
	createPaystackProvider,
	PAYSTACK_CURRENCY,
	PAYSTACK_SIGNATURE_HEADER,
	paystackSignature,
	readCheckoutMetadata,
	signCheckoutMetadata,
	type CheckoutMetadata,
	type PaystackProviderOptions,
} from "./paystack";
export { createPaystackClient, PaystackError, type PaystackClient } from "./paystack-client";
export { databasePaystackStore, type PaystackStore, type ProviderPlanKey } from "./paystack-store";
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
	CHECKOUT_METHODS,
	type CheckoutInput,
	type CheckoutMethod,
	type CheckoutResult,
	type PendingSeatChange,
	type PortalInput,
} from "./types";
