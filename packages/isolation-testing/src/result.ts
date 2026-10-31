/** Outcome of an isolation check. `failures` is empty exactly when `ok` is true. */
export type CheckResult = { ok: boolean; failures: string[] };

export const toResult = (failures: string[]): CheckResult => ({ ok: failures.length === 0, failures });
