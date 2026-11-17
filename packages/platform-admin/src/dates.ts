// CAREEROS (P3-T07): the database driver hands `timestamptz` columns of a raw `db.execute` over as text; the wrappers
// turn them into `Date`s here so callers get what the types say.
export const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
export const asDateOrNull = (value: Date | string | null): Date | null => (value === null ? null : asDate(value));
