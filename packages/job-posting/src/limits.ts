// CAREEROS (P5-T03): the caps a clipped job lives within. The extension applies them when it reads a page; the API
// applies the same numbers again, whatever a client sends, so the two cannot drift.

/** A title, company, location or salary: at most this many characters, after whitespace is collapsed. */
export const MAX_FIELD_CHARS = 300;
/** A description: at most this many characters, after whitespace is collapsed. */
export const MAX_DESCRIPTION_CHARS = 20_000;
/** A posting address. */
export const MAX_URL_CHARS = 2048;
