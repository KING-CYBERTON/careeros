import type pg from "pg";
import { createTestSchema } from "@careeros/testing";

/** Creates a throwaway schema, runs `fn`, and drops the schema even when `fn` throws. */
export async function withThrowawaySchema<T>(owner: pg.Pool, fn: (schema: string) => Promise<T>): Promise<T> {
	const schema = await createTestSchema(owner, "iso_test");
	try {
		return await fn(schema.name);
	} finally {
		await schema.drop();
	}
}
