/**
 * Backend-neutral MCP document protocol.
 *
 * Hosts authenticate callers and resolve repository-scoped documents. This
 * module only validates and presents their results through MCP.
 */

import { isAbsolute } from "node:path";
import { MAX_MESSAGE_BYTES } from "./chat/limits";

import {
	BRIEF,
	isRepository,
	MAX_REQUEST_BYTES,
	MAX_TITLE_LENGTH,
	prepare,
	REPOSITORY_PATH_PATTERN,
} from "./mcp/create";
import { prepareUpdate } from "./mcp/update";
import { MAX_IMAGE_DATA_LENGTH, MAX_IMAGE_REQUEST_BYTES, prepareImage } from "./mcp/image";
import { IMAGE_TYPES } from "./images/format";
import { isLifecycleTool, LIFECYCLE_TOOLS, lifecycleCall } from "./mcp/lifecycle";
import { normalizedTitle } from "./channels/title";

import type { Brief, CreateDocumentInput } from "./mcp/create";
import type { UpdateDocument } from "./mcp/update";
import type { UploadImageInput } from "./mcp/image";
import type { Run, Version } from "./tasks/graphs";
import type { CoordinationSnapshot } from "./tasks/coordination-snapshot";
import type { LifecycleArguments } from "./mcp/lifecycle";
import type { ImplementationLifecycle } from "./tasks/lifecycle";
import type { Issue } from "@chopin/dialect";

export type { Brief, CreateDocumentInput, CreationOrigin } from "./mcp/create";
export type { UploadImageInput } from "./mcp/image";
export type { UpdateClient, UpdateDocument, UpdateDocumentInput } from "./mcp/update";

export type DocumentSummary = {
	id: string;
	title: string;
	description?: string;
	archivedAt?: string;
};

export type Document = DocumentSummary & {
	brief?: Brief;
	source: string;
	revision: number;
};

export type DocumentReader<Caller> = {
	list(
		caller: Caller,
		repository: string,
		includeArchived?: boolean,
	): Promise<DocumentSummary[] | "forbidden">;
	read(caller: Caller, id: string): Promise<LinkedDocument | undefined>;
};

export type LinkedDocument = Document & { url: string };

export type Implementation = {
	document: Document;
	repository: { name: string; baseBranch: string; baseCommit: string };
	graph: Version;
	execution: { state: "idle" } | { state: "active"; run: Run };
	activity?: ImplementationLifecycle["activity"];
	history: ImplementationLifecycle["history"];
};

export type ImplementationInput = {
	id: string;
	planRevision: number;
	graphVersion: number;
	graphRevision: number;
	repository: string;
	branch: string;
	commit: string;
	client: { name: string; version: string; session: string };
};

export type Implementations<Caller> = {
	readImplementation(caller: Caller, id: string): Promise<Implementation | undefined | "forbidden">;
	startImplementation(
		caller: Caller,
		input: ImplementationInput,
	): Promise<
		| { kind: "started"; run: Run }
		| { kind: "active"; run: Run }
		| { kind: "forbidden" }
		| { kind: "unavailable" }
		| { kind: "refused"; reason: string }
	>;
	reportLifecycle?(
		caller: Caller,
		input: LifecycleArguments,
	): Promise<
		| { kind: "accepted" | "replayed"; lifecycle: ImplementationLifecycle }
		| { kind: "forbidden" }
		| { kind: "unavailable" }
		| { kind: "refused"; reason: string }
	>;
};

/** The read side of external coordination: decisions and draft graphs. */
export type AnswerDecisionInput = {
	id: string;
	questionId: string;
	/** The shared-draft revision the answer was prepared against. */
	revision: number;
	optionIds: string[];
	idempotencyKey: string;
};

export type AnsweredDecision =
	| { kind: "answered"; settled: { choices: string[]; by: string; at: string } }
	| { kind: "replayed"; settled: { choices: string[]; by: string; at: string } };

export type AnswerRefusal = {
	kind: "refused";
	code:
		| "stale"
		| "resolved"
		| "invalid"
		| "draft-in-progress"
		| "paused"
		| "implementation-active"
		| "idempotency-conflict"
		| "not-allowed";
	message?: string;
	current?: number;
};

export type Coordination<Caller> = {
	readSnapshot(caller: Caller, id: string): Promise<
		| { kind: "snapshot"; snapshot: CoordinationSnapshot }
		/** The document exists but was not created through MCP. */
		| { kind: "refused"; code: "provenance-refused" }
		| { kind: "refused"; code: "snapshot-unavailable" }
		| { kind: "forbidden" }
	>;
	answer?(
		caller: Caller,
		input: AnswerDecisionInput,
	): Promise<
		| AnsweredDecision
		| AnswerRefusal
		| { kind: "forbidden" }
		| { kind: "unavailable" }
		| { kind: "archived" }
	>;
};

export type CreateDocument<Caller> = {
	create(
		caller: Caller,
		input: CreateDocumentInput,
	): Promise<
		| { kind: "created"; document: LinkedDocument }
		| { kind: "replayed"; document: LinkedDocument }
		| { kind: "conflict" }
		| { kind: "title-taken" }
		| { kind: "forbidden" }
		| { kind: "unavailable" }
		| { kind: "visuals-required"; issues: Issue[] }
	>;
};

export type RenameDocumentInput = {
	id: string;
	title: string;
};

export type RenameDocument<Caller> = {
	rename(
		caller: Caller,
		input: RenameDocumentInput,
	): Promise<
		| { kind: "renamed" | "unchanged"; document: DocumentSummary }
		| { kind: "archived" | "conflict" | "forbidden" | "unavailable" | "locked" }
	>;
};

export type ArchiveDocument<Caller> = {
	archive(
		caller: Caller,
		id: string,
	): Promise<
		| { kind: "archived" | "unchanged"; document: DocumentSummary }
		| { kind: "forbidden" | "unavailable" }
	>;
};

export type RestoreDocument<Caller> = {
	restore(
		caller: Caller,
		id: string,
	): Promise<
		| { kind: "restored" | "unchanged"; document: DocumentSummary }
		| { kind: "forbidden" | "unavailable" }
	>;
};

export type InvokePlannerInput = {
	id: string;
	instruction: string;
	checkout?: string;
	/** An automatic follow-up: Chat shows a system notice rather than the caller's message. */
	as?: "system";
};

export type InvokePlannerError =
	| "document-unavailable"
	| "repository-forbidden"
	| "document-archived"
	| "planner-not-attached"
	| "planner-owner-unavailable"
	| "checkout-unverified"
	| "planner-unavailable"
	| "planner-queue-full"
	| "system-turn-forbidden"
	| "system-turn-limited";

export type InvokePlanner<Caller> = {
	invoke(caller: Caller, input: InvokePlannerInput): Promise<
		| { kind: "invoked"; document: DocumentSummary & { url: string } }
		| { kind: "refused"; code: InvokePlannerError; message?: string }
	>;
};

export type UploadImage<Caller> = {
	upload(
		caller: Caller,
		input: UploadImageInput,
	): Promise<
		| { kind: "uploaded"; path: string }
		| { kind: "archived" | "forbidden" | "unavailable" }
	>;
};

export type McpOptions<Caller> = {
	/** The host owns authentication; MCP only receives its result. */
	caller(request: Request): Promise<Caller | undefined> | Caller | undefined;
	documents: DocumentReader<Caller>;
	create?: CreateDocument<Caller>;
	update?: UpdateDocument<Caller>;
	rename?: RenameDocument<Caller>;
	archive?: ArchiveDocument<Caller>;
	restore?: RestoreDocument<Caller>;
	invoke?: InvokePlanner<Caller>;
	upload?: UploadImage<Caller>;
	implementations?: Implementations<Caller>;
	coordination?: Coordination<Caller>;
};

type Tool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
};

const MAX_DOCUMENT_ID_LENGTH = 128;
const MAX_DOCUMENT_LOCATOR_LENGTH = 2_048;
/** Plans and briefs, or one base64 image, whichever is larger. */
const MAX_BODY_BYTES = Math.max(MAX_REQUEST_BYTES, MAX_IMAGE_REQUEST_BYTES);

const DOCUMENT_IDENTITY = {
	id: { type: "string" },
	title: { type: "string" },
	description: { type: "string" },
};

const ACTIVE_DOCUMENT = {
	type: "object",
	properties: DOCUMENT_IDENTITY,
	required: ["id", "title"],
	additionalProperties: false,
};

const DOCUMENT = {
	type: "object",
	properties: {
		...DOCUMENT_IDENTITY,
		archivedAt: { type: "string", format: "date-time" },
	},
	required: ["id", "title"],
	additionalProperties: false,
};

const ARCHIVED_DOCUMENT = {
	...DOCUMENT,
	required: ["id", "title", "archivedAt"],
};

/** Validation failures of a submitted plan, returned instead of a document. */
const ISSUES = {
	type: "object",
	properties: {
		issues: {
			type: "array",
			items: {
				type: "object",
				properties: {
					code: { type: "string" },
					message: { type: "string" },
					path: { type: "string" },
				},
				required: ["code", "message", "path"],
				additionalProperties: true,
			},
		},
	},
	required: ["issues"],
	additionalProperties: false,
};

function outcome(codes: string[]) {
	return {
		type: "object",
		properties: { code: { type: "string", enum: codes } },
		required: ["code"],
		additionalProperties: false,
	};
}

const IMPLEMENTATION = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: MAX_DOCUMENT_ID_LENGTH },
		planRevision: { type: "integer", minimum: 0 },
		graphVersion: { type: "integer", minimum: 1 },
		graphRevision: { type: "integer", minimum: 1 },
		repository: { type: "string", pattern: REPOSITORY_PATH_PATTERN },
		branch: { type: "string", minLength: 1, maxLength: 255 },
		commit: { type: "string", minLength: 1, maxLength: 64 },
	},
	required: [
		"id",
		"planRevision",
		"graphVersion",
		"graphRevision",
		"repository",
		"branch",
		"commit",
	],
	additionalProperties: false,
};

/** The host can change readers, but never the public tool contract. */
export const TOOLS: Tool[] = [
	{
		name: "list_documents",
		description: "List Chopin documents available in a repository.",
		inputSchema: {
			type: "object",
			properties: {
				repository: { type: "string", pattern: REPOSITORY_PATH_PATTERN },
				includeArchived: { type: "boolean", default: false },
			},
			required: ["repository"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: { documents: { type: "array", items: DOCUMENT } },
			required: ["documents"],
			additionalProperties: false,
		},
	},
	{
		name: "read_document",
		description: "Read a Chopin document by ID or canonical URL.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_LOCATOR_LENGTH,
					pattern: "\\S",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				...DOCUMENT.properties,
				brief: BRIEF,
				source: { type: "string" },
				revision: { type: "integer", minimum: 0 },
				url: { type: "string" },
			},
			required: ["id", "title", "source", "revision", "url"],
			additionalProperties: false,
		},
	},
	{
		name: "create_document",
		description: "Create a Chopin document from a structured brief and canonical plan. New prose "
			+ "is assessed for useful visuals before saving. If issues name required diagrams or "
			+ "tables, add them beside their passages and retry; the refused draft was not saved.",
		inputSchema: {
			type: "object",
			properties: {
				idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
				repository: { type: "string", pattern: REPOSITORY_PATH_PATTERN },
				baseBranch: { type: "string", minLength: 1, maxLength: 255 },
				baseCommit: { type: "string", minLength: 1, maxLength: 64 },
				title: { type: "string", maxLength: MAX_TITLE_LENGTH },
				brief: BRIEF,
				plan: { type: "string", minLength: 1 },
			},
			required: [
				"idempotencyKey",
				"repository",
				"baseBranch",
				"baseCommit",
				"title",
				"brief",
				"plan",
			],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			oneOf: [
				{
					type: "object",
					properties: {
						...DOCUMENT.properties,
						brief: BRIEF,
						source: { type: "string" },
						revision: { type: "integer", minimum: 0 },
						url: { type: "string" },
					},
					required: ["id", "title", "brief", "source", "revision", "url"],
					additionalProperties: false,
				},
				outcome(["idempotency-conflict", "title-taken", "document-unavailable"]),
				ISSUES,
			],
		},
	},
	{
		name: "update_document",
		description: "Replace a Chopin document's canonical plan against the revision last read. "
			+ "New prose is assessed for useful visuals before saving. Repair any returned visual "
			+ "issues beside the named passages and retry against the current revision.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_LOCATOR_LENGTH,
					pattern: "\\S",
				},
				revision: { type: "integer", minimum: 0 },
				plan: { type: "string", minLength: 1 },
				idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
			},
			required: ["id", "revision", "plan", "idempotencyKey"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			oneOf: [
				{
					type: "object",
					properties: {
						...DOCUMENT.properties,
						brief: BRIEF,
						source: { type: "string" },
						revision: { type: "integer", minimum: 0 },
						url: { type: "string" },
					},
					required: ["id", "title", "source", "revision", "url"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: {
						code: { type: "string", const: "revision-conflict" },
						revision: { type: "integer", minimum: 0 },
					},
					required: ["code", "revision"],
					additionalProperties: false,
				},
				outcome([
					"idempotency-conflict",
					"document-locked",
					"protected-projection",
					"document-archived",
					"repository-forbidden",
					"document-unavailable",
				]),
				ISSUES,
			],
		},
	},
	{
		name: "rename_document",
		description:
			"Rename a document's leading H1, display title and URL together. Authored changes advance its revision.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_ID_LENGTH,
					pattern: "\\S",
				},
				title: { type: "string", maxLength: MAX_TITLE_LENGTH },
			},
			required: ["id", "title"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			oneOf: [
				ACTIVE_DOCUMENT,
				outcome([
					"document-archived",
					"title-conflict",
					"document-locked",
					"repository-forbidden",
					"document-unavailable",
				]),
			],
		},
	},
	{
		name: "archive_document",
		description: "Archive a Chopin document by ID or canonical URL.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_LOCATOR_LENGTH,
					pattern: "\\S",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			oneOf: [
				ARCHIVED_DOCUMENT,
				outcome(["repository-forbidden", "document-unavailable"]),
			],
		},
	},
	{
		name: "restore_document",
		description: "Restore an archived Chopin document by ID or canonical URL.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_LOCATOR_LENGTH,
					pattern: "\\S",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			oneOf: [
				ACTIVE_DOCUMENT,
				outcome(["repository-forbidden", "document-unavailable"]),
			],
		},
	},
	{
		name: "invoke_planner",
		description: "Post an instruction to a document's Planner, attributed to the caller, and "
			+ "return its URL without waiting for the turn. The turn runs under the document's "
			+ "Planner owner; without one, the caller's live Chopin browser login becomes the "
			+ "owner, and otherwise the call is refused. Where the Planner runs in an attached "
			+ "client, a document with no attached Planner refuses the call with "
			+ "planner-not-attached and a message saying how to attach one. Questions appear in "
			+ 'Decisions. With as: "system", for an automatic follow-up, Chat shows a short '
			+ "system notice instead of the caller's message.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_LOCATOR_LENGTH,
					pattern: "\\S",
				},
				instruction: {
					type: "string",
					minLength: 1,
					maxLength: MAX_MESSAGE_BYTES,
					pattern: "\\S",
					description: "Instruction text, at most 64 KiB in UTF-8.",
				},
				checkout: {
					type: "string",
					description: "Absolute path, on the Chopin server's machine, to a checkout of this "
						+ "repository. Used only by HARNESS=atomic, which verifies its origin and "
						+ "remembers it as the document's Planner working directory; ignored otherwise.",
				},
				as: {
					type: "string",
					enum: ["system"],
					description: "An automatic follow-up nobody typed, such as a finished workflow run: "
						+ "Chat shows a system notice naming the caller, and the instruction goes to the "
						+ "Planner alone. Only the document's creator, or the account whose client holds "
						+ "its Planner, may use it, at most 10 times per document per hour.",
				},
			},
			required: ["id", "instruction"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			oneOf: [
				{
					type: "object",
					properties: { ...DOCUMENT_IDENTITY, url: { type: "string" } },
					required: ["id", "title", "url"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: {
						code: {
							type: "string",
							enum: [
								"document-unavailable",
								"repository-forbidden",
								"document-archived",
								"planner-not-attached",
								"planner-owner-unavailable",
								"checkout-unverified",
								"planner-unavailable",
								"planner-queue-full",
								"system-turn-forbidden",
								"system-turn-limited",
							],
						},
						message: { type: "string" },
					},
					required: ["code"],
					additionalProperties: false,
				},
			],
		},
	},
	{
		name: "upload_image",
		description: "Upload a PNG, JPEG, WebP or GIF image of at most 1 MiB to a Chopin document "
			+ "and return its path and Markdown. Place the Markdown in the document with "
			+ "update_document. Only people who can read the document can load the image; "
			+ "uploading the same bytes again returns the same path.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					minLength: 1,
					maxLength: MAX_DOCUMENT_LOCATOR_LENGTH,
					pattern: "\\S",
				},
				data: {
					type: "string",
					contentEncoding: "base64",
					maxLength: MAX_IMAGE_DATA_LENGTH,
					description: "Standard base64 image bytes, at most 1 MiB decoded.",
				},
				mimeType: { type: "string", enum: [...IMAGE_TYPES] },
			},
			required: ["id", "data", "mimeType"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			oneOf: [
				{
					type: "object",
					properties: {
						path: { type: "string", pattern: "^/images/[0-9a-f]{64}\\.(?:png|jpg|webp|gif)$" },
						markdown: { type: "string" },
					},
					required: ["path", "markdown"],
					additionalProperties: false,
				},
				outcome([
					"document-unavailable",
					"repository-forbidden",
					"document-archived",
					"too-large",
					"unsupported-type",
					"signature-mismatch",
				]),
			],
		},
	},
	{
		name: "read_implementation",
		description:
			"Read the approved implementation graph, plan and repository context by document ID or canonical URL.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", minLength: 1, maxLength: MAX_DOCUMENT_LOCATOR_LENGTH },
			},
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: { type: "object", properties: {}, additionalProperties: true },
	},
	{
		name: "start_implementation",
		description: "Atomically claim the current approved implementation graph.",
		inputSchema: IMPLEMENTATION,
		outputSchema: { type: "object", properties: {}, additionalProperties: true },
	},
	...LIFECYCLE_TOOLS,
	{
		name: "read_coordination_snapshot",
		description:
			"Read the coordination snapshot of a document by ID or canonical URL: every decision with its questions, options, answer semantics, shared-draft revision, status and settled answer including who settled it, plus the current implementation-graph draft with its version, revisions, its validated definition and the canonical SHA-256 digest of exactly those bytes. Unlike read_implementation this includes draft graphs, so an external reviewer can review the thing under review before approving it. Documents not created through create_document are refused with provenance-refused.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", minLength: 1, maxLength: MAX_DOCUMENT_LOCATOR_LENGTH },
			},
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: { type: "object", properties: {}, additionalProperties: true },
	},
	{
		name: "answer_decision",
		description:
			"Record a human's answer to an open decision, asserted by the calling bridge: choose by option IDs at a shared-draft revision read from read_coordination_snapshot, with an idempotency key so an identical retry replays the original settle and a conflicting reuse is refused. The answer runs through the same core as the room's own submit path, settles under the caller's GitHub login, and refuses a decision whose shared draft has in-flight edits (draft-in-progress), whose revision moved (stale, carrying the current one), or that is paused, resolved or being implemented. Written-response questions cannot be answered here.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", minLength: 1, maxLength: MAX_DOCUMENT_LOCATOR_LENGTH },
				questionId: { type: "string", minLength: 1, maxLength: 128 },
				revision: { type: "integer", minimum: 0 },
				optionIds: {
					type: "array",
					items: { type: "string", minLength: 1, maxLength: 256 },
					minItems: 1,
					maxItems: 32,
				},
				idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
			},
			required: ["id", "questionId", "revision", "optionIds", "idempotencyKey"],
			additionalProperties: false,
		},
		outputSchema: { type: "object", properties: {}, additionalProperties: true },
	},
];

type Call = {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
};

type Reply = {
	jsonrpc: "2.0";
	id: unknown;
	result?: unknown;
	error?: { code: number; message: string };
};

function reply(id: unknown, result: unknown): Reply {
	return { jsonrpc: "2.0", id: id ?? null, result };
}

function error(id: unknown, code: number, message: string): Reply {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function text(
	value: unknown,
	isError = false,
): {
	content: Array<{ type: "text"; text: string }>;
	structuredContent: unknown;
	isError?: true;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(value) }],
		structuredContent: value,
		...(isError ? { isError: true as const } : {}),
	};
}

function toolCall(
	params: unknown,
): { name: string; arguments: Record<string, unknown> } | undefined {
	let value = record(params);
	if (!value || typeof value.name !== "string") return undefined;
	let arguments_ = value.arguments === undefined ? {} : record(value.arguments);
	return arguments_ ? { name: value.name, arguments: arguments_ } : undefined;
}

type StartArguments = Omit<ImplementationInput, "client">;

function startArguments(value: Record<string, unknown>): StartArguments | undefined {
	let expected = [
		"id",
		"planRevision",
		"graphVersion",
		"graphRevision",
		"repository",
		"branch",
		"commit",
	];
	if (
		Object.keys(value).length !== expected.length
		|| expected.some(key => !Object.hasOwn(value, key))
	) return undefined;
	if (
		!isId(value.id)
		|| !isRepository(value.repository)
		|| typeof value.branch !== "string"
		|| !value.branch.trim()
		|| typeof value.commit !== "string"
		|| !value.commit.trim()
		|| !Number.isSafeInteger(value.planRevision)
		|| (value.planRevision as number) < 0
		|| !Number.isSafeInteger(value.graphVersion)
		|| (value.graphVersion as number) < 1
		|| !Number.isSafeInteger(value.graphRevision)
		|| (value.graphRevision as number) < 1
	) return undefined;
	return value as StartArguments;
}

function clientInfo(value: unknown): { name: string; version: string } {
	let info = record(record(value)?.clientInfo);
	return {
		name: typeof info?.name === "string" && info.name.trim() ? info.name : "unknown",
		version: typeof info?.version === "string" && info.version.trim() ? info.version : "unknown",
	};
}

function isId(value: unknown): value is string {
	return typeof value === "string"
		&& Array.from(value).length <= MAX_DOCUMENT_ID_LENGTH
		&& value.trim().length > 0;
}

function isLocator(value: unknown): value is string {
	return typeof value === "string"
		&& Array.from(value).length <= MAX_DOCUMENT_LOCATOR_LENGTH
		&& value.trim().length > 0;
}

function shortText(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.trim().length > 0
		&& Array.from(value).length <= maximum;
}

function answerArguments(value: Record<string, unknown>): AnswerDecisionInput | undefined {
	let optionIds = Array.isArray(value.optionIds)
			&& value.optionIds.length >= 1 && value.optionIds.length <= 32
			&& value.optionIds.every(item => shortText(item, 256))
		? value.optionIds as string[]
		: undefined;
	let revision = typeof value.revision === "number" && Number.isInteger(value.revision)
			&& value.revision >= 0
		? value.revision
		: undefined;
	return isLocator(value.id)
			&& shortText(value.questionId, 128) && shortText(value.idempotencyKey, 128)
			&& revision !== undefined && optionIds
		? {
			id: value.id,
			questionId: value.questionId,
			revision,
			optionIds,
			idempotencyKey: value.idempotencyKey,
		}
		: undefined;
}

function listArguments(
	value: Record<string, unknown>,
): { repository: string; includeArchived: boolean } | undefined {
	let keys = Object.keys(value);
	if (
		(keys.length !== 1 && keys.length !== 2)
		|| !Object.hasOwn(value, "repository")
		|| keys.some(key => key !== "repository" && key !== "includeArchived")
		|| !isRepository(value.repository)
		|| (Object.hasOwn(value, "includeArchived")
			&& typeof value.includeArchived !== "boolean")
	) return undefined;
	return {
		repository: value.repository,
		includeArchived: value.includeArchived === true,
	};
}

function renameArguments(value: Record<string, unknown>): RenameDocumentInput | undefined {
	if (
		Object.keys(value).length !== 2
		|| !Object.hasOwn(value, "id")
		|| !Object.hasOwn(value, "title")
		|| !isId(value.id)
	) return undefined;
	let title = normalizedTitle(value.title);
	return title !== undefined ? { id: value.id, title } : undefined;
}

function isJsonRpcId(value: unknown): value is string | number | null {
	return value === null || typeof value === "string" || typeof value === "number";
}

function hasObjectParams(call: Call): boolean {
	return call.params === undefined
		|| (call.method !== "initialize" && call.method !== "tools/list")
		|| record(call.params) !== undefined;
}

function acceptsEvents(request: Request): boolean {
	let selected: { specificity: number; quality: number } | undefined;
	for (let item of (request.headers.get("accept") ?? "*/*").split(",")) {
		let [media, ...parameters] = item.split(";").map(value => value.trim());
		let specificity = media?.toLowerCase() === "text/event-stream"
			? 2
			: media?.toLowerCase() === "text/*"
			? 1
			: media === "*/*"
			? 0
			: -1;
		if (specificity < 0) continue;
		let quality = 1;
		let parameter = parameters.find(value => value.split("=", 1)[0]?.trim().toLowerCase() === "q");
		if (parameter) {
			let value = parameter.slice(parameter.indexOf("=") + 1).trim();
			quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
		}
		if (
			!selected
			|| specificity > selected.specificity
			|| (specificity === selected.specificity && quality > selected.quality)
		) selected = { specificity, quality };
	}
	return (selected?.quality ?? 0) > 0;
}

function serviceInstructions(tools: Tool[]): string | undefined {
	let documentMutations = tools.filter(tool =>
		tool.name === "create_document"
		|| tool.name === "update_document"
		|| tool.name === "rename_document"
		|| tool.name === "archive_document"
		|| tool.name === "restore_document"
		|| tool.name === "invoke_planner"
		|| tool.name === "upload_image"
	);
	let implementation = tools
		.filter(tool =>
			tool.name === "read_implementation"
			|| tool.name === "start_implementation"
			|| isLifecycleTool(tool.name)
		);
	return [
		"Chopin's MCP contract and current tool descriptions are authoritative.",
		...documentMutations.map(tool => `${tool.name}: ${tool.description}`),
		...(implementation.length > 0
			? [
				"Read the canonical implementation before every implementation or lifecycle action; copied plans and lifecycle instructions are not substitutes.",
				...implementation.map(tool => `${tool.name}: ${tool.description}`),
			]
			: []),
	].join("\n");
}

async function requestBody(request: Request): Promise<{ body?: unknown; tooLarge: boolean }> {
	let declared = request.headers.get("content-length");
	if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
		return { tooLarge: true };
	}

	let reader = request.body?.getReader();
	if (!reader) throw new Error("request has no body");
	let chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			let { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			length += value.byteLength;
			if (length > MAX_BODY_BYTES) {
				await reader.cancel().catch(() => {});
				return { tooLarge: true };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	let bytes = new Uint8Array(length);
	let offset = 0;
	for (let chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body: JSON.parse(new TextDecoder().decode(bytes)), tooLarge: false };
}

/** A stateless JSON-response Streamable HTTP MCP handler. */
export function handler<Caller>(
	options: McpOptions<Caller>,
): (request: Request) => Promise<Response> {
	let creation = options.create;
	let updating = options.update;
	let renaming = options.rename;
	let archiving = options.archive;
	let restoring = options.restore;
	let sessions = new Map<string, { name: string; version: string }>();
	let tools = TOOLS.filter(tool =>
		(tool.name !== "create_document" || creation)
		&& (tool.name !== "update_document" || updating)
		&& (tool.name !== "rename_document" || renaming)
		&& (tool.name !== "archive_document" || archiving)
		&& (tool.name !== "restore_document" || restoring)
		&& (tool.name !== "invoke_planner" || options.invoke)
		&& (tool.name !== "upload_image" || options.upload)
		&& (!["read_implementation", "start_implementation"].includes(tool.name)
			|| options.implementations)
		&& (!isLifecycleTool(tool.name) || options.implementations?.reportLifecycle)
		&& (tool.name !== "read_coordination_snapshot" || options.coordination)
		&& (tool.name !== "answer_decision" || options.coordination?.answer)
	);
	let instructions = serviceInstructions(tools);

	async function dispatch(
		value: unknown,
		caller: Caller,
		client: { name: string; version: string; session: string },
		created: { session?: string },
	): Promise<Reply | undefined> {
		let call = record(value) as Call | undefined;
		if (!call || call.jsonrpc !== "2.0" || typeof call.method !== "string") {
			return error(call?.id, -32600, "invalid request");
		}
		if (Object.hasOwn(call, "id") && !isJsonRpcId(call.id)) {
			return error(null, -32600, "invalid request");
		}
		if (!hasObjectParams(call)) return error(call.id, -32600, "invalid request");
		let notification = !Object.hasOwn(call, "id");
		let respond = (result: unknown) => notification ? undefined : reply(call.id, result);

		switch (call.method) {
			case "initialize": {
				let session = crypto.randomUUID();
				sessions.set(session, clientInfo(call.params));
				created.session = session;
				return respond({
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "chopin", version: "0.0.0" },
					...(instructions ? { instructions } : {}),
				});
			}

			case "notifications/initialized":
				return undefined;

			case "tools/list":
				return respond({ tools });

			case "tools/call": {
				let tool = toolCall(call.params);
				if (!tool) {
					return notification
						? undefined
						: error(call.id, -32602, "invalid tool arguments");
				}
				if (tool.name === "list_documents") {
					let input = listArguments(tool.arguments);
					if (!input) {
						return notification
							? undefined
							: error(call.id, -32602, "list_documents requires a repository");
					}
					let documents = await options.documents.list(
						caller,
						input.repository,
						input.includeArchived,
					);
					return documents === "forbidden"
						? respond(text({ code: "repository-forbidden" }, true))
						: respond(text({ documents }));
				}
				if (tool.name === "read_document") {
					if (Object.keys(tool.arguments).length !== 1 || !isLocator(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "read_document requires an id or URL");
					}
					let document = await options.documents.read(caller, tool.arguments.id);
					return document ? respond(text(document)) : respond({ content: [], isError: true });
				}
				if (tool.name === "create_document" && creation) {
					let prepared = prepare(tool.arguments);
					if (!prepared) {
						return notification
							? undefined
							: error(call.id, -32602, "create_document requires a valid draft");
					}
					if ("issues" in prepared) return respond(text({ issues: prepared.issues }, true));
					let outcome = await creation.create(caller, prepared.input);
					if (outcome.kind === "visuals-required") {
						return respond(text({ issues: outcome.issues }, true));
					}
					if (outcome.kind === "created" || outcome.kind === "replayed") {
						return respond(text(outcome.document));
					}
					if (outcome.kind === "conflict") {
						return respond(text({ code: "idempotency-conflict" }, true));
					}
					if (outcome.kind === "title-taken") {
						return respond(text({ code: "title-taken" }, true));
					}
					if (outcome.kind === "unavailable") {
						return respond(text({ code: "document-unavailable" }, true));
					}
					return respond({ content: [], isError: true });
				}
				if (tool.name === "update_document" && updating) {
					let prepared = prepareUpdate(tool.arguments);
					if (!prepared) {
						return notification
							? undefined
							: error(call.id, -32602, "update_document requires a valid revision and plan");
					}
					if ("issues" in prepared) return respond(text({ issues: prepared.issues }, true));
					let outcome = await updating.update(caller, prepared.input, {
						name: client.name,
						version: client.version,
					});
					if (outcome.kind === "visuals-required") {
						return respond(text({ issues: outcome.issues }, true));
					}
					if (outcome.kind === "updated" || outcome.kind === "replayed") {
						return respond(text(outcome.document));
					}
					if (outcome.kind === "revision-conflict") {
						return respond(text({
							code: "revision-conflict",
							revision: outcome.revision,
						}, true));
					}
					if (outcome.kind === "conflict") {
						return respond(text({ code: "idempotency-conflict" }, true));
					}
					if (outcome.kind === "locked") {
						return respond(text({ code: "document-locked" }, true));
					}
					if (outcome.kind === "protected") {
						return respond(text({ code: "protected-projection" }, true));
					}
					if (outcome.kind === "archived") {
						return respond(text({ code: "document-archived" }, true));
					}
					if (outcome.kind === "unavailable") {
						return respond(text({ code: "document-unavailable" }, true));
					}
					return respond(text({ code: "repository-forbidden" }, true));
				}
				if (tool.name === "rename_document" && renaming) {
					let input = renameArguments(tool.arguments);
					if (!input) {
						return notification
							? undefined
							: error(call.id, -32602, "rename_document requires an id and valid title");
					}
					let outcome = await renaming.rename(caller, input);
					if (outcome.kind === "renamed" || outcome.kind === "unchanged") {
						return respond(text(outcome.document));
					}
					let code = outcome.kind === "archived"
						? "document-archived"
						: outcome.kind === "locked"
						? "document-locked"
						: outcome.kind === "conflict"
						? "title-conflict"
						: outcome.kind === "forbidden"
						? "repository-forbidden"
						: "document-unavailable";
					return respond(text({ code }, true));
				}
				if (tool.name === "archive_document" && archiving) {
					if (Object.keys(tool.arguments).length !== 1 || !isLocator(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "archive_document requires an id or URL");
					}
					let outcome = await archiving.archive(caller, tool.arguments.id);
					if (outcome.kind === "archived" || outcome.kind === "unchanged") {
						return respond(text(outcome.document));
					}
					return respond(text({
						code: outcome.kind === "forbidden"
							? "repository-forbidden"
							: "document-unavailable",
					}, true));
				}
				if (tool.name === "restore_document" && restoring) {
					if (Object.keys(tool.arguments).length !== 1 || !isLocator(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "restore_document requires an id or URL");
					}
					let outcome = await restoring.restore(caller, tool.arguments.id);
					if (outcome.kind === "restored" || outcome.kind === "unchanged") {
						return respond(text(outcome.document));
					}
					return respond(text({
						code: outcome.kind === "forbidden"
							? "repository-forbidden"
							: "document-unavailable",
					}, true));
				}
				if (tool.name === "invoke_planner" && options.invoke) {
					let args = tool.arguments;
					if (
						Object.keys(args).some(key => !["id", "instruction", "checkout", "as"].includes(key))
						|| !isLocator(args.id)
						|| typeof args.instruction !== "string" || !args.instruction.trim()
						|| Buffer.byteLength(args.instruction) > MAX_MESSAGE_BYTES
						|| (Object.hasOwn(args, "checkout")
							&& (typeof args.checkout !== "string" || !isAbsolute(args.checkout)))
						|| (Object.hasOwn(args, "as") && args.as !== "system")
					) {
						return notification
							? undefined
							: error(
								call.id,
								-32602,
								"invoke_planner requires an id or URL, instruction, optional absolute checkout, and optional as: system",
							);
					}
					let result = await options.invoke.invoke(caller, args as InvokePlannerInput);
					return result.kind === "invoked"
						? respond(text(result.document))
						: respond(text({
							code: result.code,
							...(result.message ? { message: result.message } : {}),
						}, true));
				}
				if (tool.name === "upload_image" && options.upload) {
					let prepared = prepareImage(tool.arguments);
					if (!prepared) {
						return notification
							? undefined
							: error(
								call.id,
								-32602,
								"upload_image requires an id or URL, base64 data, and an image mimeType",
							);
					}
					if ("refusal" in prepared) return respond(text({ code: prepared.refusal }, true));
					let outcome = await options.upload.upload(caller, prepared.input);
					if (outcome.kind === "uploaded") {
						return respond(text({ path: outcome.path, markdown: `![](${outcome.path})` }));
					}
					return respond(text({
						code: outcome.kind === "archived"
							? "document-archived"
							: outcome.kind === "forbidden"
							? "repository-forbidden"
							: "document-unavailable",
					}, true));
				}
				if (tool.name === "read_implementation") {
					if (Object.keys(tool.arguments).length !== 1 || !isLocator(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "read_implementation requires an id or URL");
					}
					if (!options.implementations) {
						return respond(text({ code: "implementation-unavailable" }, true));
					}
					let implementation = await options.implementations.readImplementation(
						caller,
						tool.arguments.id,
					);
					if (implementation === "forbidden") {
						return respond(text({ code: "repository-forbidden" }, true));
					}
					return implementation
						? respond(text(implementation))
						: respond(text({ code: "implementation-unavailable" }, true));
				}
				if (tool.name === "start_implementation") {
					let input = startArguments(tool.arguments);
					if (!input) {
						return notification
							? undefined
							: error(call.id, -32602, "start_implementation requires current revisions");
					}
					if (!client.session || !sessions.has(client.session)) {
						return respond(text({ code: "session-required" }, true));
					}
					if (!options.implementations) {
						return respond(text({ code: "implementation-unavailable" }, true));
					}
					let outcome = await options.implementations.startImplementation(caller, {
						...input,
						client,
					});
					if (outcome.kind === "started" || outcome.kind === "active") {
						return respond(text({ state: outcome.kind, run: outcome.run }));
					}
					if (outcome.kind === "forbidden") {
						return respond(text({ code: "repository-forbidden" }, true));
					}
					if (outcome.kind === "unavailable") {
						return respond(text({ code: "document-unavailable" }, true));
					}
					return respond(text({ code: outcome.reason }, true));
				}
				let lifecycle = lifecycleCall(tool.name, tool.arguments);
				if (lifecycle.known) {
					if (!lifecycle.input) {
						return notification
							? undefined
							: error(call.id, -32602, `${tool.name} requires its documented arguments`);
					}
					if (!client.session || !sessions.has(client.session)) {
						return respond(text({ code: "session-required" }, true));
					}
					let report = options.implementations?.reportLifecycle;
					if (!report) return respond(text({ code: "implementation-unavailable" }, true));
					let outcome = await report(caller, lifecycle.input);
					if (outcome.kind === "accepted" || outcome.kind === "replayed") {
						return respond(text(outcome.lifecycle));
					}
					if (outcome.kind === "forbidden") {
						return respond(text({ code: "repository-forbidden" }, true));
					}
					if (outcome.kind === "unavailable") {
						return respond(text({ code: "document-unavailable" }, true));
					}
					return outcome.kind === "refused"
						? respond(text({ code: outcome.reason }, true))
						: respond(text({ code: "implementation-unavailable" }, true));
				}
				if (tool.name === "read_coordination_snapshot") {
					if (Object.keys(tool.arguments).length !== 1 || !isLocator(tool.arguments.id)) {
						return notification
							? undefined
							: error(call.id, -32602, "read_coordination_snapshot requires an id or URL");
					}
					let read = options.coordination;
					if (!read) {
						return respond(text({ code: "snapshot-unavailable" }, true));
					}
					let outcome = await read.readSnapshot(caller, tool.arguments.id);
					if (outcome.kind === "snapshot") {
						return respond(text(outcome.snapshot));
					}
					if (outcome.kind === "forbidden") {
						return respond(text({ code: "repository-forbidden" }, true));
					}
					return respond(text({ code: outcome.code }, true));
				}
				if (tool.name === "answer_decision") {
					let input = answerArguments(tool.arguments);
					if (!input) {
						return notification
							? undefined
							: error(
								call.id,
								-32602,
								"answer_decision requires an id or URL, questionId, revision, optionIds and idempotencyKey",
							);
					}
					let answer = options.coordination?.answer;
					if (!answer) {
						return respond(text({ code: "not-allowed" }, true));
					}
					let outcome = await answer(caller, input);
					if (outcome.kind === "answered" || outcome.kind === "replayed") {
						return respond(text({ state: outcome.kind, settled: outcome.settled }));
					}
					if (outcome.kind === "forbidden") {
						return respond(text({ code: "repository-forbidden" }, true));
					}
					if (outcome.kind === "unavailable") {
						return respond(text({ code: "document-unavailable" }, true));
					}
					if (outcome.kind === "archived") {
						return respond(text({ code: "document-archived" }, true));
					}
					return respond(text({
						code: outcome.code,
						...(outcome.message !== undefined ? { message: outcome.message } : {}),
						...(outcome.current !== undefined ? { current: outcome.current } : {}),
					}, true));
				}
				return notification ? undefined : error(call.id, -32601, "tool not found");
			}

			default:
				return notification ? undefined : error(call.id, -32601, "method not found");
		}
	}

	return async request => {
		let caller = await options.caller(request);
		if (caller === undefined) return new Response("unauthorized", { status: 401 });

		if (request.method === "GET") {
			if (!acceptsEvents(request)) return new Response("not acceptable", { status: 406 });
			return new Response(null, {
				headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
			});
		}
		if (request.method !== "POST") {
			return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
		}

		let session = request.headers.get("mcp-session-id") ?? "";
		let client = { ...(sessions.get(session) ?? { name: "unknown", version: "unknown" }), session };
		let created: { session?: string } = {};
		let body: unknown;
		try {
			let read = await requestBody(request);
			if (read.tooLarge) return new Response("request too large", { status: 413 });
			body = read.body;
		} catch {
			return Response.json(error(null, -32700, "parse error"));
		}
		let result = await dispatch(body, caller, client, created);
		return result
			? Response.json(result, {
				headers: created.session ? { "mcp-session-id": created.session } : undefined,
			})
			: new Response(null, { status: 202 });
	};
}
