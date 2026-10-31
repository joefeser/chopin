import { describe, expect, it } from "bun:test";

import {
	classifyCoordination,
	coordinationFingerprint,
	restoreCoordinationOps,
} from "./coordination-ops";
import { restore } from "./graphs";

import type { CoordinationOpRecord } from "./coordination-ops";
import type { Version } from "./graphs";

let answer: CoordinationOpRecord = {
	idempotencyKey: "bridge:answer:1",
	kind: "answer",
	fingerprint: "f".repeat(64),
	principal: "chopin-bridge-bot",
	payloadDigest: "d".repeat(64),
	result: { questionId: "01M696N0", choice: "01M696N0PQQNQS9HJYXMJ5PJHR", settledBy: "joefeser" },
	committedAt: "2026-10-31T16:00:00.000Z",
};

let approve: CoordinationOpRecord = {
	idempotencyKey: "bridge:approve:1",
	kind: "approve",
	fingerprint: "a".repeat(64),
	principal: "chopin-bridge-bot",
	payloadDigest: "b".repeat(64),
	result: { graphVersion: 1, graphRevision: 2, planRevision: 37, approver: "joefeser" },
	committedAt: "2026-10-31T16:01:00.000Z",
};

describe("coordinationFingerprint", () => {
	it("is deterministic and payload-sensitive", () => {
		let base = {
			idempotencyKey: "k",
			kind: "answer",
			principal: "bot",
			payloadDigest: "d",
		} as const;
		expect(coordinationFingerprint(base)).toBe(coordinationFingerprint(base));
		expect(coordinationFingerprint(base)).not.toBe(
			coordinationFingerprint({ ...base, payloadDigest: "other" }),
		);
		expect(coordinationFingerprint(base)).not.toBe(
			coordinationFingerprint({ ...base, principal: "other-bot" }),
		);
	});
});

describe("classifyCoordination", () => {
	it("classifies fresh, replay, and conflict", () => {
		expect(classifyCoordination(undefined, { idempotencyKey: "k", fingerprint: "x" }))
			.toEqual({ kind: "fresh" });
		expect(
			classifyCoordination([answer], {
				idempotencyKey: answer.idempotencyKey,
				fingerprint: answer.fingerprint,
			}),
		)
			.toEqual({ kind: "replay", record: answer });
		expect(
			classifyCoordination([answer], {
				idempotencyKey: answer.idempotencyKey,
				fingerprint: "different",
			}),
		)
			.toEqual({ kind: "conflict", record: answer });
		expect(
			classifyCoordination([approve], {
				idempotencyKey: answer.idempotencyKey,
				fingerprint: answer.fingerprint,
			}),
		)
			.toEqual({ kind: "fresh" });
	});
});

describe("restoreCoordinationOps", () => {
	it("treats absent as empty", () => {
		expect(restoreCoordinationOps(undefined)).toEqual([]);
	});

	it("round-trips valid records of both kinds", () => {
		expect(restoreCoordinationOps([answer, approve])).toEqual([answer, approve]);
	});

	it("refuses malformed records instead of guessing", () => {
		expect(() => restoreCoordinationOps("nope")).toThrow();
		expect(() => restoreCoordinationOps([{ ...answer, principal: "" }])).toThrow();
		expect(() => restoreCoordinationOps([{ ...answer, kind: "approve" }])).toThrow();
		expect(() => restoreCoordinationOps([{ ...approve, result: answer.result }])).toThrow();
		expect(() => restoreCoordinationOps([{ ...answer, committedAt: "not a date " }])).toThrow();
	});
});

describe("graph version attribution restore", () => {
	let draft: Version = {
		number: 1,
		revision: 1,
		planRevision: 5,
		state: "draft",
		definition: {
			tasks: [
				{
					id: "model",
					title: "Model the graph",
					context: "The graph is durable document state.",
					goal: "Define versioned task graphs.",
					acceptance: ["The graph has versions.", "Versions retain their plan revision."],
					dependsOn: [],
				},
				{
					id: "validate",
					title: "Validate task graphs",
					context: "The model protects implementation runs.",
					goal: "Reject invalid dependency graphs.",
					acceptance: ["Dependencies name known tasks.", "Cycles are refused."],
					dependsOn: ["model"],
				},
			],
		},
	};

	it("keeps optional attribution fields through restore", () => {
		let attributed = {
			versions: [{
				...draft,
				approver: "joefeser",
				operationKey: "bridge:approve:1",
				draftedBy: "script",
			}],
		};
		let restored = restore(attributed);
		expect(restored?.versions[0]?.approver).toBe("joefeser");
		expect(restored?.versions[0]?.operationKey).toBe("bridge:approve:1");
		expect(restored?.versions[0]?.draftedBy).toBe("script");
	});

	it("restores legacy versions without attribution unchanged", () => {
		expect(restore({ versions: [draft] })?.versions[0]).toEqual(draft);
	});

	it("refuses invalid attribution instead of dropping it silently", () => {
		expect(restore({ versions: [{ ...draft, approver: "" }] })).toBeUndefined();
		expect(restore({ versions: [{ ...draft, draftedBy: 7 }] })).toBeUndefined();
	});
});
