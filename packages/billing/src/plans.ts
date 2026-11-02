import type { PlanPrices } from "./pricing";
import { eq } from "drizzle-orm";
import { db } from "@reactive-resume/db/client";
import * as schema from "@reactive-resume/db/schema";

// CAREEROS (P3-T04): reads of the `plan` table. Global (no organization), readable by every role.

const columns = {
	id: schema.plan.id,
	pricingModel: schema.plan.pricingModel,
	seatLimit: schema.plan.seatLimit,
	active: schema.plan.active,
	priceMonthlyUsdCents: schema.plan.priceMonthlyUsdCents,
	priceAnnualUsdCents: schema.plan.priceAnnualUsdCents,
	priceMonthlyKes: schema.plan.priceMonthlyKes,
	priceAnnualKes: schema.plan.priceAnnualKes,
};

export async function loadPlanPrices(planId: string): Promise<PlanPrices | null> {
	const [row] = await db.select(columns).from(schema.plan).where(eq(schema.plan.id, planId)).limit(1);
	return row ?? null;
}

export type PlanListing = PlanPrices & { name: string; aiCreditsPerSeat: number; features: Record<string, boolean> };

/** The plans an organization can choose from, cheapest first. Prices are placeholders until the owner sets them (D2). */
export async function listActivePlans(): Promise<PlanListing[]> {
	return await db
		.select({
			...columns,
			name: schema.plan.name,
			aiCreditsPerSeat: schema.plan.aiCreditsPerSeat,
			features: schema.plan.features,
		})
		.from(schema.plan)
		.where(eq(schema.plan.active, true));
}
