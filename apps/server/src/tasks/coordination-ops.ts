import { createHash } from "node:crypto";

/**
 * Receiver-side idempotency and attribution for external coordination
 * operations. Mirrors the `mcpUpdates` discipline: an identical retry
 * replays the original committed result, and reuse of a key with a
 * different payload is a typed conflict, never a second effect. The
 * records live in the channel sidecar so they commit atomically with
 * the answer or approval they describe.
 */

export type CoordinationOpKind = "answer" | "approve";

/** What an answer operation durably settled. */
export type AnswerOpResult = {
	questionId: string;
	choice: string;
	settledBy: string;
};

/** What an approval operation durably approved. */
export type ApproveOpResult = {
	graphVersion: number;
	graphRevision: number;
	planRevision: number;
	approver: string;
};

export type CoordinationOpResult = AnswerOpResult | ApproveOpResult;

export type CoordinationOpRecord = {
	idempotencyKey: string;
	kind: CoordinationOpKind;
	/** Binds this key to one exact payload; mismatching reuse conflicts. */
	fingerprint: string;
	/** GitHub login of the calling principal. The bridge asserts its human; Chopin records the principal. */
	principal: string;
	payloadDigest: string;
	result: CoordinationOpResult;
	committedAt: string;
};

export function coordinationFingerprint(input: {
	idempotencyKey: string;
	kind: CoordinationOpKind;
	principal: string;
	payloadDigest: string;
}): string {
	return createHash("sha256").update(JSON.stringify({
		idempotencyKey: input.idempotencyKey,
		kind: input.kind,
		principal: input.principal,
		payloadDigest: input.payloadDigest,
	})).digest("hex");
}

export type CoordinationClassification =
	| { kind: "fresh" }
	| { kind: "replay"; record: CoordinationOpRecord }
	| { kind: "conflict"; record: CoordinationOpRecord };

export function classifyCoordination(
	existing: readonly CoordinationOpRecord[] | undefined,
	input: { idempotencyKey: string; fingerprint: string },
): CoordinationClassification {
	let record = existing?.find(entry => entry.idempotencyKey === input.idempotencyKey);
	if (!record) return { kind: "fresh" };
	return record.fingerprint === input.fingerprint
		? { kind: "replay", record }
		: { kind: "conflict", record };
}

function text(value: unknown, maximum: number): string | undefined {
	return typeof value === "string"
			&& value.length > 0
			&& Array.from(value).length <= maximum
			&& value.trim() === value
		? value
		: undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Result records carry exactly their kind's fields; contradictory shapes refuse. */
function exact(value: unknown, keys: string[]): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	let record = value as Record<string, unknown>;
	let found = Object.keys(record).sort();
	let expected = [...keys].sort();
	return found.length === expected.length && found.every((key, index) => key === expected[index])
		? record
		: undefined;
}

function result(kind: CoordinationOpKind, value: unknown): CoordinationOpResult | undefined {
	let record = exact(
		value,
		kind === "answer"
			? ["choice", "questionId", "settledBy"]
			: ["approver", "graphRevision", "graphVersion", "planRevision"],
	);
	if (!record) return undefined;
	if (kind === "answer") {
		let questionId = text(record.questionId, 128);
		let choice = text(record.choice, 256);
		let settledBy = text(record.settledBy, 100);
		return questionId && choice && settledBy
			? { questionId, choice, settledBy }
			: undefined;
	}
	let graphVersion = positiveInteger(record.graphVersion);
	let graphRevision = positiveInteger(record.graphRevision);
	let planRevision = positiveInteger(record.planRevision);
	let approver = text(record.approver, 100);
	return graphVersion && graphRevision && planRevision && approver
		? { graphVersion, graphRevision, planRevision, approver }
		: undefined;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Restores stored records; malformed entries refuse the whole sidecar. */
export function restoreCoordinationOps(value: unknown): CoordinationOpRecord[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("coordinationOps must be an array when present");
	let records: CoordinationOpRecord[] = [];
	let seen = new Set<string>();
	for (let entry of value) {
		if (!entry || typeof entry !== "object") {
			throw new Error("coordinationOps has a malformed record");
		}
		let record = entry as Record<string, unknown>;
		let idempotencyKey = text(record.idempotencyKey, 128);
		let rawKind = record.kind;
		let kind: CoordinationOpKind | undefined = rawKind === "answer" || rawKind === "approve"
			? rawKind
			: undefined;
		let fingerprint = text(record.fingerprint, 128);
		let principal = text(record.principal, 100);
		let payloadDigest = text(record.payloadDigest, 128);
		let committedAt = text(record.committedAt, 64);
		if (
			!idempotencyKey
			|| !kind
			|| !fingerprint
			|| !principal
			|| !payloadDigest
			|| !committedAt
			|| !ISO_TIMESTAMP.test(committedAt)
		) {
			throw new Error("coordinationOps has an invalid record");
		}
		if (seen.has(idempotencyKey)) {
			throw new Error("coordinationOps has duplicate idempotency keys");
		}
		seen.add(idempotencyKey);
		let checked = result(kind, record.result);
		if (!checked) {
			throw new Error("coordinationOps result does not match its kind");
		}
		records.push({
			idempotencyKey,
			kind,
			fingerprint,
			principal,
			payloadDigest,
			result: checked,
			committedAt,
		});
	}
	return records;
}
