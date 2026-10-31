import { generateId } from "@reactive-resume/utils/string";

// Upstream primary keys are text holding a UUIDv7 (`generateId()`), so organization ids are text too.
export function createOrgIds(): { orgA: string; orgB: string } {
	return { orgA: generateId(), orgB: generateId() };
}
