/**
 * The external approval: an allowlisted coordination caller approves the
 * implementation-graph draft it reviewed, proving it approves exactly the
 * bytes it read. Fork-only; never offered upstream.
 *
 * The shape is the browser's own build path (`queueBuild`): drain, then one
 * exclusive room operation comparing every reviewed counter and the digest
 * before approving, checking readiness both ways — the plan's helper and an
 * explicit open-decision pass, because a reopened decision must block an
 * approval even when the helper alone would let it through.
 */

import { createHash } from "node:crypto";

import { approveGraph, definitionDigest, validate } from "../tasks/graphs";
import { planningReadiness } from "../tasks/plan-graphs";
import { announceImplementation } from "../tasks/notifications";
import { isOpenStatus } from "../questions/records";
import { classifyCoordination, coordinationFingerprint } from "./../tasks/coordination-ops";
import { drain, exclusive, persistExclusive } from "../plan/service";

import type { Plan } from "../plan/service";
import type { CoordinationOpRecord } from "../tasks/coordination-ops";

export type ExternalApprovalInput = {
	/** The counters the reviewer read from read_coordination_snapshot. */
	graphVersion: number;
	graphRevision: number;
	planRevision: number;
	/** The canonical digest of exactly those reviewed bytes. */
	digest: string;
	/** One operation key per approval; identical retry replays, reuse conflicts. */
	idempotencyKey: string;
	/** GitHub login of the allowlisted caller; the recorded approver. */
	approver: string;
};

export type ApprovedGraph = {
	state: "approved";
	version: number;
	revision: number;
	planRevision: number;
	approver: string;
	operationKey: string;
};

export type ExternalApproval =
	| { kind: "approved"; graph: ApprovedGraph }
	| { kind: "replayed"; graph: ApprovedGraph }
	| {
		kind: "refused";
		code:
			| "missing"
			| "stale-plan"
			| "reviewed-graph-changed"
			| "digest-mismatch"
			| "not-ready"
			| "open-decision"
			| "implementation-active"
			| "not-draft"
			| "idempotency-conflict"
			| "durability";
		blockers?: string[];
		openDecisions?: string[];
		message?: string;
	};

/** The complete reviewed request an approval asks to settle. */
function approvalPayloadDigest(input: ExternalApprovalInput): string {
	return createHash("sha256").update(JSON.stringify({
		idempotencyKey: input.idempotencyKey,
		graphVersion: input.graphVersion,
		graphRevision: input.graphRevision,
		planRevision: input.planRevision,
		digest: input.digest,
	})).digest("hex");
}

function approvalOf(version: {
	number: number;
	revision: number;
	planRevision: number;
	approver: string;
	operationKey: string;
}): ApprovedGraph {
	return {
		state: "approved",
		version: version.number,
		revision: version.revision,
		planRevision: version.planRevision,
		approver: version.approver,
		operationKey: version.operationKey,
	};
}

/**
 * Approve the reviewed draft, following the build path's own shape. Takes
 * the plan's queue itself; the adapter that calls it must not hold it.
 */
export async function approveExternal(
	plan: Plan,
	input: ExternalApprovalInput,
): Promise<ExternalApproval> {
	let payloadDigest = approvalPayloadDigest(input);
	let fingerprint = coordinationFingerprint({
		idempotencyKey: input.idempotencyKey,
		kind: "approve",
		principal: input.approver,
		payloadDigest,
	});
	let classified = classifyCoordination(plan.coordinationOps, {
		idempotencyKey: input.idempotencyKey,
		fingerprint,
	});
	if (classified.kind === "replay") {
		let result = classified.record.result;
		if (!("graphVersion" in result)) {
			return { kind: "refused", code: "idempotency-conflict" };
		}
		return {
			kind: "replayed",
			graph: {
				state: "approved",
				version: result.graphVersion,
				revision: result.graphRevision,
				planRevision: result.planRevision,
				approver: result.approver,
				operationKey: classified.record.idempotencyKey,
			},
		};
	}
	if (classified.kind === "conflict") {
		return { kind: "refused", code: "idempotency-conflict" };
	}

	await drain(plan);
	return exclusive(plan, async () => {
		let version = plan.graph?.versions.at(-1);
		if (!version) return { kind: "refused" as const, code: "missing" as const };

		// The counters, split by what moved: the plan beneath the draft, or
		// the draft itself out from under its review.
		if (input.planRevision !== plan.revision) {
			return { kind: "refused" as const, code: "stale-plan" as const };
		}
		if (
			version.planRevision !== input.planRevision || version.number !== input.graphVersion
			|| version.revision !== input.graphRevision
		) {
			return { kind: "refused" as const, code: "reviewed-graph-changed" as const };
		}

		// The bytes: the digest covers the validated definition, exactly as
		// the snapshot the reviewer read computed it.
		let checked = validate(version.definition);
		if (!checked.ok || definitionDigest(checked.value) !== input.digest) {
			return { kind: "refused" as const, code: "digest-mismatch" as const };
		}

		if (
			plan.execution
			|| plan.builds.some(build => ["queued", "starting", "running"].includes(build.state))
		) {
			return { kind: "refused" as const, code: "implementation-active" as const };
		}

		// An open decision, by either status, is not a thing an approval
		// settles over. The readiness helper checks only "open", so the
		// explicit pass comes first: a reopened decision must refuse here,
		// with its own code, rather than slip past as ready.
		let openDecisions = [...plan.records.values()]
			.filter(record => isOpenStatus(record.status))
			.map(record => record.id);
		if (openDecisions.length > 0) {
			return {
				kind: "refused" as const,
				code: "open-decision" as const,
				openDecisions,
			};
		}

		let ready = await planningReadiness(plan, input.planRevision);
		if (!ready.ok) {
			return { kind: "refused" as const, code: "not-ready" as const, blockers: ready.blockers };
		}

		let result = approveGraph({
			graph: plan.graph,
			revision: plan.revision,
			approval: { approver: input.approver, operationKey: input.idempotencyKey },
		});
		if (!result.ok) {
			// A graph that is not a draft — approved, locked, superseded — is
			// one refusal: this operation approves drafts.
			return { kind: "refused" as const, code: "not-draft" as const, message: result.reason };
		}

		let record: CoordinationOpRecord = {
			idempotencyKey: input.idempotencyKey,
			kind: "approve",
			fingerprint,
			principal: input.approver,
			payloadDigest,
			result: {
				graphVersion: version.number,
				graphRevision: version.revision,
				planRevision: version.planRevision,
				approver: input.approver,
			},
			committedAt: new Date().toISOString(),
		};
		let previous = { graph: plan.graph, coordinationOps: plan.coordinationOps };
		plan.graph = result.value;
		plan.coordinationOps = [...plan.coordinationOps, record];
		try {
			await persistExclusive(plan);
		} catch (error) {
			plan.graph = previous.graph;
			plan.coordinationOps = previous.coordinationOps;
			return {
				kind: "refused" as const,
				code: "durability" as const,
				message: error instanceof Error ? error.message : undefined,
			};
		}
		announceImplementation(plan);
		let approved = result.value.versions.at(-1)!;
		return {
			kind: "approved" as const,
			graph: approvalOf({
				number: approved.number,
				revision: approved.revision,
				planRevision: approved.planRevision,
				approver: approved.approver!,
				operationKey: approved.operationKey!,
			}),
		};
	});
}
