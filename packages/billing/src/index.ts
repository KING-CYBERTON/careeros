export { audit, type AuditContext, type AuditTarget } from "./audit";
export {
	aiCreditsTotal,
	buildEntitlements,
	effectiveSeatLimit,
	TRIAL_DAYS,
	getEntitlements,
	isFeatureEnabled,
	type EntitlementInputs,
	type Entitlements,
} from "./entitlements";
export { BillingError, type BillingErrorCode } from "./errors";
export {
	FEATURE_DEFAULTS,
	FEATURE_KEYS,
	isFeatureKey,
	resolveFeature,
	resolveFeatures,
	type FeatureInputs,
	type FeatureKey,
} from "./features";
export { hasEntitlementsCache, memoizeInRequest, runWithEntitlementsCache } from "./request-cache";
// CAREEROS (P3-T04): provider interface, state machine, event intake, trial, manual payments and the periodic job.
export {
	BILLING_EVENT_TYPES,
	BILLING_PROVIDER_IDS,
	WebhookIgnored,
	WebhookPayloadError,
	WebhookSignatureError,
	type BillingEvent,
	type BillingEventType,
	type BillingProviderId,
} from "./events";
export { applyBillingEvent, type IntakeOutcome, type IntakeResult } from "./intake";
export { runBillingJobs, type BillingJobResult } from "./jobs";
export { recordManualPayment, type ManualPaymentInput } from "./manual-payment";
export { listActivePlans, loadPlanPrices, type PlanListing } from "./plans";
export { isSelfServicePlan, priceFor, SELF_SERVICE_PLAN_IDS, type Currency, type PlanPrices } from "./pricing";
export {
	createFakeProvider,
	fakeDecisionEvent,
	FAKE_SIGNATURE_HEADER,
	manualProvider,
	newFakeEventId,
	ProviderUnsupportedError,
	readFakeSession,
	resolveBillingProvider,
	signFakeEvent,
	signFakeSession,
	type BillingProvider,
	type BillingProviderConfig,
	type BillingProviderSetting,
	type CancelInput,
	type ChangeSeatsInput,
	type CheckoutInput,
	type CheckoutResult,
	type FakeCheckoutSession,
	type FakeEventBody,
	type PortalInput,
	type SignedFakeEvent,
} from "./providers";
export {
	GRACE_DAYS,
	nextState,
	PERSONAL_PLAN_ID,
	TRIAL_PLAN_ID,
	TRIAL_SEATS,
	type AuditEntry,
	type BillingState,
	type InternalEvent,
	type StateEvent,
	type SubscriptionPatch,
	type SubscriptionState,
	type Transition,
} from "./state";
export { loadBillingState, lockOrganizationBilling } from "./store";
export { startTrial } from "./trial";
