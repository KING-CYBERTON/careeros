// CareerOS (P1-Q03): the procedure inventory and request builder for the cross-organization id fuzz.
//
// Pure logic with no imports from the application: the spec feeds it the OpenAPI document that the running server
// generates from the oRPC router object (`/api/openapi/spec.json`), and the unit test in
// apps/server/src/openapi/cross-org-inventory.test.ts feeds it the router object itself. Nothing here lists the
// procedures that exist, so a new procedure cannot slip past the fuzz unnoticed.

// ---------------------------------------------------------------------------------------------------------------
// OpenAPI reading

export type JsonSchema = {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	allOf?: JsonSchema[];
	enum?: unknown[];
	const?: unknown;
	format?: string;
	minLength?: number;
	minItems?: number;
	minimum?: number;
	exclusiveMinimum?: number;
	contentEncoding?: string;
	default?: unknown;
	$ref?: string;
	[key: string]: unknown;
};

type OpenApiParameter = { in: string; name: string; required?: boolean; schema?: JsonSchema };
type OpenApiOperation = {
	operationId?: string;
	tags?: string[];
	parameters?: OpenApiParameter[];
	requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
};
export type OpenApiDocument = {
	paths: Record<string, Record<string, OpenApiOperation>>;
	components?: { schemas?: Record<string, JsonSchema> };
};

export type Operation = {
	/** "METHOD /path/{param}": the stable name used by the skip list, the overrides and the failure messages. */
	key: string;
	method: string;
	path: string;
	pathParams: string[];
	/** The first enum value of each path parameter that has one (a document type, an export format). */
	pathDefaults: Record<string, string>;
	queryParams: { name: string; schema: JsonSchema }[];
	/** The JSON request body schema, with references resolved. Undefined when the operation sends none. */
	body: JsonSchema | undefined;
	multipart: boolean;
	/** Every property name in the path, query and body (nested included) that looks like an id. */
	idFields: string[];
};

const ID_FIELD = /^(id|ids)$|[a-z](Id|Ids)$/;
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export function isIdField(name: string) {
	return ID_FIELD.test(name);
}

export function resolveSchema(document: OpenApiDocument, schema: JsonSchema | undefined, depth = 0): JsonSchema {
	if (!schema) return {};
	if (schema.$ref) {
		if (depth > 12) return {};
		const name = schema.$ref.split("/").pop() ?? "";
		return resolveSchema(document, document.components?.schemas?.[name], depth + 1);
	}
	return schema;
}

function collectIdFields(document: OpenApiDocument, schema: JsonSchema | undefined, into: Set<string>, depth = 0) {
	const resolved = resolveSchema(document, schema);
	if (depth > 8) return;
	for (const [name, property] of Object.entries(resolved.properties ?? {})) {
		if (isIdField(name)) into.add(name);
		collectIdFields(document, property, into, depth + 1);
	}
	collectIdFields(document, resolved.items, into, depth + 1);
	for (const branch of [...(resolved.anyOf ?? []), ...(resolved.oneOf ?? []), ...(resolved.allOf ?? [])])
		collectIdFields(document, branch, into, depth + 1);
}

/** Reads every operation of the generated OpenAPI document, with the id-like fields each one takes. */
export function readOperations(document: OpenApiDocument): Operation[] {
	const operations: Operation[] = [];
	for (const [path, item] of Object.entries(document.paths)) {
		for (const [method, operation] of Object.entries(item)) {
			if (!HTTP_METHODS.has(method)) continue;
			const parameters = operation.parameters ?? [];
			const content = operation.requestBody?.content ?? {};
			const json = content["application/json"]?.schema;
			const ids = new Set<string>();
			for (const parameter of parameters) if (isIdField(parameter.name)) ids.add(parameter.name);
			collectIdFields(document, json, ids);
			operations.push({
				key: `${method.toUpperCase()} ${path}`,
				method: method.toUpperCase(),
				path,
				pathParams: parameters.filter((parameter) => parameter.in === "path").map((parameter) => parameter.name),
				pathDefaults: Object.fromEntries(
					parameters.flatMap((parameter) => {
						const first = resolveSchema(document, parameter.schema).enum?.[0];
						return parameter.in === "path" && typeof first === "string" ? [[parameter.name, first]] : [];
					}),
				),
				queryParams: parameters
					.filter((parameter) => parameter.in === "query")
					.map((parameter) => ({ name: parameter.name, schema: resolveSchema(document, parameter.schema) })),
				body: json ? resolveSchema(document, json) : undefined,
				multipart: !json && "multipart/form-data" in content,
				idFields: [...ids].sort(),
			});
		}
	}
	return operations.sort((left, right) => left.key.localeCompare(right.key));
}

// ---------------------------------------------------------------------------------------------------------------
// The skip list. The only valid reason is "takes no tenant id": no path, query or body field is an id, so there is
// nothing of Organization A's to present. The spec fails if an entry here does take an id, so the list cannot hide
// a procedure that matters. Anything not listed here must have a request built for it.

/** Routes that are not part of the tenant API, or that take nothing that names a row. */
export const NO_TENANT_ID: Record<string, string> = {
	"GET /api/health": "takes no tenant id: the process health probe",
	"GET /statistics/github/stars": "takes no tenant id: a public counter",
	"GET /statistics": "takes no tenant id: totals of the whole instance",
	"GET /flags": "takes no tenant id: feature flags",
	"GET /auth/providers": "takes no tenant id: the sign-in methods",
	"GET /auth/profile": "takes no tenant id: the caller's own profile",
	"PATCH /auth/profile": "takes no tenant id: the caller's own profile",
	"GET /auth/account/export": "takes no tenant id: exports the caller's own active organization",
	"DELETE /auth/account": "takes no tenant id: deletes the caller's own account (would end the session under test)",
	"GET /auth/api-keys": "takes no tenant id: lists the caller's own keys, asserted empty of Organization A's",
	"POST /auth/api-keys": "takes no tenant id: creates a key for the caller",
	"GET /application-profile": "takes no tenant id: keyed by the caller's own organization",
	"PUT /application-profile": "takes no tenant id: keyed by the caller's own organization",
	"DELETE /application-profile": "takes no tenant id: keyed by the caller's own organization",
	"GET /career/profile": "takes no tenant id: keyed by the caller's own organization",
	"PUT /career/profile": "takes no tenant id: keyed by the caller's own organization",
	"GET /career/schedules": "takes no tenant id: lists the caller's own schedules",
	"GET /career/notifications": "takes no tenant id: lists the caller's own notices",
	"GET /career/opportunities": "takes no tenant id: lists the caller's own opportunities",
	"GET /applications/lanes": "takes no tenant id: the caller's own lanes",
	"GET /applications/tags": "takes no tenant id: the caller's own tags",
	"GET /ai-providers": "takes no tenant id: lists the caller's own providers",
	"POST /ai-providers": "takes no tenant id: creates a provider",
	"POST /ai/content-reports": "takes no tenant id: a report of generated content",
	"POST /applications/ai/search-postings": "takes no tenant id: searches the web",
	"POST /applications/ai/parse-posting": "takes no tenant id: parses pasted text",
	"POST /applications/ai/autofill": "takes no tenant id: parses pasted text",
	"POST /applications/ai/posting-searches": "takes no tenant id: searches the web",
	"POST /applications/ai/posting-parses": "takes no tenant id: parses pasted text",
	"POST /applications/ai/autofills": "takes no tenant id: parses pasted text",
	"GET /custom-domain": "takes no tenant id: the caller's own domain",
	"PUT /custom-domain": "takes no tenant id: the caller's own domain",
	"DELETE /custom-domain": "takes no tenant id: the caller's own domain",
	"POST /custom-domain/verify": "takes no tenant id: the caller's own domain",
	"GET /integrations/web-access": "takes no tenant id: the caller's own credential",
	"PUT /integrations/web-access": "takes no tenant id: the caller's own credential",
	"DELETE /integrations/web-access": "takes no tenant id: the caller's own credential",
	"POST /integrations/web-access/test": "takes no tenant id: the caller's own credential",
	"POST /integrations/web-access/tests": "takes no tenant id: the caller's own credential",
	"GET /documents": "takes no tenant id: lists the caller's own documents",
	"GET /documents/page": "takes no tenant id: lists the caller's own documents",
	"GET /documents/counts": "takes no tenant id: counts the caller's own documents",
	"DELETE /documents/trash": "takes no tenant id: empties the caller's own trash",
	"DELETE /documents/trash/expired": "takes no tenant id: purges the caller's own expired trash",
	"GET /resumes": "takes no tenant id: lists the caller's own resumes",
	"GET /resumes/tags": "takes no tenant id: the caller's own tags",
	"POST /resumes": "takes no tenant id: creates a resume",
	"POST /resumes/import":
		"takes no tenant id: creates a resume from pasted data (its ids are item ids inside the document)",
	"POST /resumes/imports":
		"takes no tenant id: creates a resume from pasted data (its ids are item ids inside the document)",
	"POST /cover-letters/import":
		"takes no tenant id: creates a letter from pasted data (its ids are item ids inside the document)",
	"POST /cover-letters/imports":
		"takes no tenant id: creates a letter from pasted data (its ids are item ids inside the document)",
	"GET /agent/threads": "takes no tenant id: lists the caller's own threads",
	"GET /applications/stats": "takes no tenant id: counts the caller's own applications",
	"POST /applications/lanes": "takes no tenant id: creates a lane",
	"POST /career/voice/transcribe": "takes no tenant id: transcribes uploaded audio",
	"GET /resumes/{username}/{slug}": "takes no tenant id: public, addressed by username and slug",
	"POST /resumes/{username}/{slug}/password/verify": "takes no tenant id: public, addressed by username and slug",
	"POST /resumes/{username}/{slug}/password-verifications":
		"takes no tenant id: public, addressed by username and slug",
	"POST /resumes/{username}/{slug}/statistics/download": "takes no tenant id: public, addressed by username and slug",
	"POST /resumes/{username}/{slug}/statistics/downloads": "takes no tenant id: public, addressed by username and slug",
	"POST /resumes/file-imports": "takes no tenant id: creates a resume from a file",
	"POST /pdf-checks": "takes no tenant id: checks an uploaded PDF",
	"POST /files": "takes no tenant id: uploads a file into the caller's own storage",
	"DELETE /files": "takes no tenant id: deletes by a path in the caller's own storage",
};

/** Skip-list entries whose only ids are item ids inside an imported document, so they are allowed to carry id fields. */
export const ITEM_IDS_ONLY = new Set([
	"POST /resumes/import",
	"POST /resumes/imports",
	"POST /cover-letters/import",
	"POST /cover-letters/imports",
]);

// ---------------------------------------------------------------------------------------------------------------
// Ids of Organization A's rows and the request built from them.

export const ID_KINDS = [
	"resume",
	"resumeVersion",
	"letter",
	"letterVersion",
	"application",
	"lane",
	"timelineEntry",
	"interview",
	"provider",
	"thread",
	"message",
	"attachment",
	"fact",
	"story",
	"schedule",
	"answer",
	"opportunity",
	"notification",
	"savedItem",
	"transcript",
	"apiKey",
] as const;
export type IdKind = (typeof ID_KINDS)[number];
export type SeedIds = Record<IdKind, string>;

/** A path prefix decides what a bare `id` (or `versionId`) names. First match wins. */
const PREFIX_KIND: [RegExp, IdKind][] = [
	[/^\/resumes\//, "resume"],
	[/^\/cover-letters\//, "letter"],
	[/^\/applications\/lanes\//, "lane"],
	[/^\/applications(\/|$)/, "application"],
	[/^\/documents(\/|$)/, "resume"],
	[/^\/ai\//, "resume"],
	[/^\/ai-providers\//, "provider"],
	[/^\/agent\/threads\//, "thread"],
	[/^\/agent\/attachments\//, "attachment"],
	[/^\/career\/facts\//, "fact"],
	[/^\/career\/stories\//, "story"],
	[/^\/career\/schedules\//, "schedule"],
	[/^\/career\/answers\//, "answer"],
	[/^\/career\/opportunities\//, "opportunity"],
	[/^\/career\/notifications\//, "notification"],
	[/^\/career\/saved\//, "savedItem"],
	[/^\/career\/voice\/transcripts\//, "transcript"],
	[/^\/auth\/api-keys/, "apiKey"],
];

/** Operations whose bare `id` cannot be told from the path alone. */
const ID_KIND_OVERRIDE: Record<string, IdKind> = {
	"POST /agent/messages/send": "thread",
	"POST /agent/messages/stop": "thread",
	"GET /agent/messages/resume": "thread",
	"POST /agent/messages/edit-status": "thread",
	"POST /career/generate": "application",
	// The ids nested in these bodies are the workspace answers' own.
	"PATCH /career/workspace/{applicationId}": "answer",
	"POST /career/workspace/{applicationId}/submit": "answer",
	"POST /career/workspace/{applicationId}/answers": "answer",
};

const FIELD_KIND: Record<string, IdKind> = {
	resumeId: "resume",
	coverLetterId: "letter",
	applicationId: "application",
	excludeId: "application",
	laneId: "lane",
	replacementId: "lane",
	entryId: "timelineEntry",
	interviewId: "interview",
	aiProviderId: "provider",
	providerId: "provider",
	threadId: "thread",
	messageId: "message",
	attachmentIds: "attachment",
	offerIds: "savedItem",
	factIds: "fact",
	storyIds: "story",
	storyId: "story",
	keyId: "apiKey",
	scheduleId: "schedule",
	answerId: "answer",
	// Not tenant ids: the client's own correlation values, sent so the request still validates.
	sessionId: "resume",
	toolCallId: "message",
};

function bareIdKind(operation: Pick<Operation, "key" | "path">, field: string): IdKind | undefined {
	const forced = ID_KIND_OVERRIDE[operation.key];
	if (forced) return forced;
	if (field === "versionId") return operation.path.startsWith("/cover-letters") ? "letterVersion" : "resumeVersion";
	for (const [prefix, kind] of PREFIX_KIND) if (prefix.test(operation.path)) return kind;
	return undefined;
}

/** What an id field named `field` holds for this operation. Undefined means the inventory needs a mapping. */
export function kindOfField(
	operation: Pick<Operation, "key" | "path">,
	field: string,
	forced?: IdKind,
): IdKind | undefined {
	if (field === "id" || field === "ids") return forced ?? bareIdKind(operation, field);
	if (field === "versionId") return bareIdKind(operation, field);
	// The bulk routes under /applications and /documents take plural ids of their own kind.
	return FIELD_KIND[field];
}

// ---------------------------------------------------------------------------------------------------------------
// Sampling a valid value for a schema, so the request is not turned away by validation before the ownership check.

function sampleString(schema: JsonSchema): string {
	if (schema.format === "email") return "nobody@example.test";
	if (schema.format === "uri" || schema.format === "url") return "https://example.test/x";
	if (schema.format === "date-time") return new Date().toISOString();
	if (schema.format === "date") return new Date().toISOString().slice(0, 10);
	if (schema.contentEncoding === "base64") return "eA==";
	const length = Math.max(schema.minLength ?? 0, 1);
	return "x".repeat(length);
}

export function sample(document: OpenApiDocument, input: JsonSchema | undefined, depth = 0): unknown {
	const schema = resolveSchema(document, input);
	if (depth > 8) return undefined;
	if (schema.const !== undefined) return schema.const;
	if (schema.enum?.length) return schema.enum[0];
	if (schema.allOf?.length) {
		const parts = schema.allOf.map((part) => sample(document, part, depth + 1));
		return Object.assign({}, ...parts.filter((part) => part && typeof part === "object"));
	}
	const branches = schema.anyOf ?? schema.oneOf;
	if (branches?.length) {
		const concrete = branches.find((branch) => {
			const type = resolveSchema(document, branch).type;
			return type !== "null" && !(Array.isArray(type) && type.includes("null") && type.length === 1);
		});
		return sample(document, concrete ?? branches[0], depth + 1);
	}
	const type = Array.isArray(schema.type) ? schema.type.find((candidate) => candidate !== "null") : schema.type;
	switch (type) {
		case "string":
			return sampleString(schema);
		case "integer":
			return Math.max(schema.minimum ?? 0, schema.exclusiveMinimum === undefined ? 0 : schema.exclusiveMinimum + 1);
		case "number":
			return Math.max(schema.minimum ?? 1, 1);
		case "boolean":
			return false;
		case "array": {
			const count = schema.minItems ?? 0;
			return Array.from({ length: count }, () => sample(document, schema.items, depth + 1));
		}
		case "object":
		default: {
			if (!schema.properties) return type === "object" ? {} : undefined;
			const out: Record<string, unknown> = {};
			for (const name of schema.required ?? []) {
				const value = sample(document, schema.properties[name], depth + 1);
				if (value !== undefined) out[name] = value;
			}
			return out;
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Overrides: where the sampled request is not enough. Every entry says why.

export type Override = {
	/** What a bare `id` names, when the path cannot say (a document route run once for letters). */
	kind?: IdKind;
	/** Body or query fields to set on top of the sampled request (after the ids are filled in). */
	set?: (ids: SeedIds) => Record<string, unknown>;
	/** Path parameters that are not ids (a document type, an export format): the value to use. */
	path?: Record<string, string>;
	/** Statuses accepted besides 404, with the reason. The body is still scanned for Organization A's values. */
	allow?: { statuses: number[]; why: string };
	/** The same operation again with other settings (for example a cover letter where the first run used a resume). */
	variants?: Override[];
};

const LETTER: Override = { kind: "letter", path: { type: "letter" } };
export const OVERRIDES: Record<string, Override> = {
	// Document routes run once for a resume and once for a cover letter.
	"DELETE /documents/{type}/{id}": { variants: [LETTER] },
	"DELETE /documents/{type}/{id}/trash": { variants: [LETTER] },
	"PATCH /documents/{type}/{id}/name": { variants: [LETTER] },
	"PUT /documents/{type}/{id}/tags": { variants: [LETTER] },
	"PUT /documents/{type}/{id}/lock": { variants: [LETTER] },
	"PUT /documents/{type}/{id}/application": { variants: [LETTER] },
	"PUT /documents/{type}/{id}/trash": { variants: [LETTER] },
};

// ---------------------------------------------------------------------------------------------------------------
// Building a request.

export type BuiltRequest = {
	method: string;
	url: string;
	query: Record<string, string | string[]>;
	json: unknown;
	multipart: boolean;
	/** Every id of Organization A that this request carries, so an echo of it is not mistaken for a leak. */
	sentIds: string[];
};

function setPath(target: Record<string, unknown>, field: string, value: unknown) {
	target[field] = value;
}

/** Puts A's ids into every id field of a sampled object, nested ones included. */
function fillIds(
	document: OpenApiDocument,
	operation: Pick<Operation, "key" | "path">,
	schema: JsonSchema | undefined,
	value: unknown,
	ids: SeedIds,
	sent: Set<string>,
	problems: string[],
	forced: IdKind | undefined,
	depth = 0,
) {
	const resolved = resolveSchema(document, schema);
	if (depth > 8 || !value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Record<string, unknown>;
	for (const [name, property] of Object.entries(resolved.properties ?? {})) {
		if (isIdField(name)) {
			const kind = kindOfField(operation, name, forced);
			if (!kind) {
				problems.push(`${operation.key}: no id kind is mapped for the field "${name}"`);
				continue;
			}
			const id = ids[kind];
			const isList = resolveSchema(document, property).type === "array" || name.endsWith("Ids") || name === "ids";
			setPath(record, name, isList ? [id] : id);
			sent.add(id);
		} else {
			const child = record[name] ?? sample(document, property, depth + 1);
			if (child && typeof child === "object") {
				const nested = resolveSchema(document, property);
				if (nested.type === "array" && Array.isArray(child)) {
					// Arrays of objects: fill the first element's ids when the item schema has any.
					if (child.length === 0 && collectHasId(document, nested.items)) {
						const first = sample(document, nested.items, depth + 1);
						child.push(first);
					}
					for (const element of child)
						fillIds(document, operation, nested.items, element, ids, sent, problems, forced, depth + 1);
				} else fillIds(document, operation, property, child, ids, sent, problems, forced, depth + 1);
				if (record[name] === undefined && hasContent(child)) record[name] = child;
			}
		}
	}
}

function hasContent(value: object) {
	return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
}

function collectHasId(document: OpenApiDocument, schema: JsonSchema | undefined) {
	const found = new Set<string>();
	collectIdFields(document, schema, found);
	return found.size > 0;
}

export function buildRequest(
	document: OpenApiDocument,
	operation: Operation,
	ids: SeedIds,
	override: Override | undefined,
	problems: string[],
): BuiltRequest {
	const sent = new Set<string>();
	let url = operation.path;
	for (const name of operation.pathParams) {
		let value: string | undefined = override?.path?.[name] ?? operation.pathDefaults[name];
		if (value === undefined && isIdField(name)) {
			const kind = kindOfField(operation, name, override?.kind);
			if (kind) {
				value = ids[kind];
				sent.add(value);
			} else problems.push(`${operation.key}: no id kind is mapped for the path parameter "${name}"`);
		}
		value ??= "x";
		url = url.replace(`{${name}}`, encodeURIComponent(value));
	}

	const query: Record<string, string | string[]> = {};
	let json: unknown;
	const isRead = operation.method === "GET";
	if (operation.body) {
		const body = (sample(document, operation.body) ?? {}) as Record<string, unknown>;
		fillIds(document, operation, operation.body, body, ids, sent, problems, override?.kind);
		for (const name of operation.pathParams) delete body[name];
		Object.assign(body, override?.set?.(ids));
		if (isRead) {
			for (const [name, value] of Object.entries(body))
				query[name] = Array.isArray(value) ? value.map(String) : String(value);
		} else json = body;
	}
	for (const parameter of operation.queryParams) {
		if (!isIdField(parameter.name)) continue;
		const kind = kindOfField(operation, parameter.name, override?.kind);
		if (!kind) {
			problems.push(`${operation.key}: no id kind is mapped for the query parameter "${parameter.name}"`);
			continue;
		}
		query[parameter.name] = ids[kind];
		sent.add(ids[kind]);
	}
	if (isRead && override?.set)
		for (const [name, value] of Object.entries(override.set(ids))) query[name] = String(value);

	return { method: operation.method, url, query, json, multipart: operation.multipart, sentIds: [...sent] };
}

/** Whether a response body carries Organization A's data, ignoring ids the request itself sent. */
export function findLeaks(body: string, markers: string[], foreignIds: string[], sentIds: string[]): string[] {
	const haystack = body.toLowerCase();
	const leaks: string[] = [];
	for (const marker of markers) if (haystack.includes(marker.toLowerCase())) leaks.push(`value "${marker}"`);
	for (const id of foreignIds) if (!sentIds.includes(id) && haystack.includes(id.toLowerCase())) leaks.push(`id ${id}`);
	return leaks;
}

// ---------------------------------------------------------------------------------------------------------------
// Empty results. A list or bulk call may answer 200 as long as it answers with nothing.

const COUNT_FIELD = /count|total|deleted|updated|affected|removed|restored|purged|changed|trashed/i;

/** True for null, "", a boolean, an empty array, or an object whose arrays are empty and whose counts are zero. */
export function isEmptyResult(value: unknown, depth = 0): boolean {
	if (value === null || value === undefined || value === "" || typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === "number") return value === 0;
	if (typeof value !== "object" || depth > 4) return false;
	for (const [name, child] of Object.entries(value)) {
		if (Array.isArray(child) && child.length > 0) return false;
		if (typeof child === "number" && COUNT_FIELD.test(name) && child !== 0) return false;
		if (child && typeof child === "object" && !Array.isArray(child) && !isEmptyResult(child, depth + 1)) return false;
	}
	return true;
}

/** What 2xx answers are accepted besides NOT_FOUND, by operation key (or MCP tool name), and why. */
export const EMPTY_OK: Record<string, string> = {};

// ---------------------------------------------------------------------------------------------------------------
// MCP: every tool is a procedure under another name, so the same request builder serves it.

/** A REST-like path for a tool name, so the prefix rules decide what a bare `id` names. */
export function mcpSyntheticPath(tool: string): string {
	const name = tool.replace(/^api_/, "");
	const rules: [RegExp, string][] = [
		[/cover_letter/, "/cover-letters/x"],
		[/documents|resume|download_resume|duplicate_resume|apply_resume_patch/, "/resumes/x"],
		[/lane/, "/applications/lanes/x"],
		[/application|autofill|score_|tailor_|draft_application/, "/applications/x"],
		[/ai_providers/, "/ai-providers/x"],
		[/agent_attachments/, "/agent/attachments/x"],
		[/agent_/, "/agent/threads/x"],
		[/fact/, "/career/facts/x"],
		[/stor(y|ies)/, "/career/stories/x"],
		[/schedule/, "/career/schedules/x"],
		[/answer/, "/career/answers/x"],
		[/opportunit/, "/career/opportunities/x"],
		[/notification/, "/career/notifications/x"],
		[/saved|apply_reply/, "/career/saved/x"],
		[/transcript/, "/career/voice/transcripts/x"],
		[/api_key/, "/auth/api-keys/x"],
	];
	for (const [pattern, path] of rules) if (pattern.test(name)) return path;
	return "/unknown/x";
}

export type McpTool = { name: string; inputSchema?: JsonSchema & { $defs?: Record<string, JsonSchema> } };

/** The arguments for a tool call that carry Organization A's ids, or undefined when the tool takes no id. */
export function buildMcpArguments(tool: McpTool, ids: SeedIds, problems: string[]) {
	const schema = tool.inputSchema ?? {};
	const document: OpenApiDocument = { paths: {}, components: { schemas: schema.$defs ?? {} } };
	const found = new Set<string>();
	collectIdFields(document, schema, found);
	if (found.size === 0) return undefined;
	const operation = { key: tool.name, path: mcpSyntheticPath(tool.name) };
	const args = (sample(document, schema) ?? {}) as Record<string, unknown>;
	const sent = new Set<string>();
	fillIds(document, operation, schema, args, ids, sent, problems, undefined);
	return { args, sentIds: [...sent], idFields: [...found].sort() };
}
