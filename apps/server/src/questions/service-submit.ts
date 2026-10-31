import * as Question from "@chopin/question";
import * as Y from "yjs";

import { createHash } from "node:crypto";

import { activeSettleDeferral } from "../conversation-plan/preference";
import { ConversationCapacityError } from "../conversation-plan/events";

import * as Anchors from "./anchors";
import { isOpenStatus } from "./records";

import * as room from "../plan/room";
import * as Store from "./store";

import { broadcast, fail, reply } from "../wire";
import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";

import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";

import type { Record } from "./records";
import { appendProseEffect, settleIntent } from "../conversation-plan/prose-job";
import { appendFollowupEffect } from "./decision-followup";
import { plannerToActOn } from "./answer-turns";
import { decisionGeneration } from "./card-actions";

import type { CardEvent } from "./card-event";
import { announce, emit, pending } from "./card-notifications";
import { decide } from "./service-definition";
import { classifyCoordination, coordinationFingerprint } from "../tasks/coordination-ops";

import type { Answer } from "@chopin/question";
import type { Claim } from "./store-types";
import type { CoordinationOpRecord } from "../tasks/coordination-ops";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 declarations; import/export wrappers only.
export async function submit(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Submit.Ask>,
	onCommitted?: (intent: NonNullable<ReturnType<typeof settleIntent>>) => void,
	/** A saved answer the Planner asked for without waiting, which it should now act on. */
	onPlannerAnswer?: (id: string, generation: number) => void,
): Promise<void> {
	if (Service.implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
	if (pausedForVerification(plan, msg.id)) {
		return reply(ws, msg.rid, {
			kind: "question:submit",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "invalid",
			message: "This decision is paused pending verification",
		});
	}
	let claimed = Store.claimSubmit(
		plan.questions,
		msg.id,
		msg.revision,
		ws.data.handle,
		msg.suggestedOptionId,
	);
	if (!claimed.ok) {
		return reply(ws, msg.rid, { kind: "question:submit", ts: 0, id: msg.id, ...claimed });
	}
	const outcome = await commitAnswer(
		plan,
		server,
		roomId,
		claimed.claim,
		claimed.answers,
		ws.data.handle,
		{ onCommitted },
	);
	if (!outcome.ok) {
		if (outcome.reason === "invalid") {
			return reply(ws, msg.rid, {
				kind: "question:submit",
				ts: 0,
				id: msg.id,
				ok: false,
				reason: "invalid",
				message: outcome.message,
			});
		}
		return fail(
			ws,
			msg.rid,
			outcome.error instanceof ConversationCapacityError
				|| outcome.error instanceof Error && outcome.error.message === "implementation is active"
				? outcome.error.message
				: "could not save the decision",
		);
	}
	outcome.finish();
	let event: CardEvent = {
		kind: "decided",
		id: msg.id,
		...(outcome.record.threadId ? { threadId: outcome.record.threadId } : {}),
		actor: ws.data.handle,
		optionIds: outcome.optionIds,
	};
	for (
		let notify of [
			() =>
				reply(ws, msg.rid, {
					kind: "question:submit",
					ts: 0,
					id: msg.id,
					ok: true,
					answers: outcome.answers,
					resolver: ws.data.handle,
				}),
			() =>
				plannerToActOn(outcome.record, claimed.claim.entry)
					? onPlannerAnswer?.(msg.id, decisionGeneration(outcome.record))
					: undefined,
		]
	) {
		try {
			notify();
		} catch (error) {
			console.error("[questions] could not announce a saved decision:", error);
		}
	}
	notifyAnswered(plan, server, roomId, {
		id: msg.id,
		resolver: ws.data.handle,
		answers: outcome.answers,
	}, event);
}

/** Whether a decision is paused pending conversation verification. */
function pausedForVerification(plan: Plan, id: string): boolean {
	let record = plan.records.get(id);
	let thread = plan.conversationPlan.threads.find(item => item.id === record?.threadId);
	return !!thread && !!activeSettleDeferral(thread, plan.conversationPlan.events);
}

/** What a claimed settle's durable half did. */
export type CommitOutcome =
	| {
		ok: true;
		answers: Answer[];
		record: Record;
		optionIds: string[];
		/** Closes the claim once the answer is durable; call after announcing. */
		finish: () => Store.Ended;
	}
	| { ok: false; reason: "invalid"; message: string }
	| { ok: false; reason: "failure"; error: unknown };

export type CommitExtras = {
	/** Fires with the settle intent once the answer is durable. */
	onCommitted?: (intent: NonNullable<ReturnType<typeof settleIntent>>) => void;
	/** A B4 operation record that commits atomically with the answer. */
	coordination?: CoordinationOpRecord;
};

/**
 * The durable half of any settle: the same re-checks, staged projection,
 * size check and persist-before-broadcast commit for the room's own submit
 * path and for an external coordination answer, so the two cannot drift.
 */
async function commitAnswer(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	claim: Claim,
	answers: Answer[],
	resolver: string,
	extras: CommitExtras = {},
): Promise<CommitOutcome> {
	let id = claim.id;
	let invalid: string | undefined;
	let failure: unknown;
	let finish: (() => Store.Ended) | undefined;
	let optionIds: string[] = [];
	let answeredRecord: Record | undefined;
	try {
		await Service.exclusive(plan, async () => {
			if (Service.implementationActive(plan)) throw new Error("implementation is active");
			if (pausedForVerification(plan, id)) {
				invalid = "This decision is paused pending verification";
				return;
			}
			let record = plan.records.get(id);
			if (!record || !isOpenStatus(record.status)) {
				invalid = "This decision is no longer open";
				return;
			}
			if (plan.questions.open.get(id) !== claim.entry) {
				invalid = "This decision is no longer open";
				return;
			}
			let stagedDocument: room.Document | undefined;
			try {
				stagedDocument = await room.restore(
					plan.document.epoch,
					Y.encodeStateAsUpdate(plan.document.doc),
					room.project(plan.document),
					[],
				);
				stagedDocument.seq = plan.document.seq;
				let projected = decide({ status: "answered", answers }, record.definition);
				let chosen: { [question: string]: string[] } = {};
				record.definition.questions.forEach((question, index) => {
					let ids = answers[index]?.optionIds;
					if (ids?.length) chosen[question.id] = ids;
				});
				optionIds = Object.values(chosen).flat();
				let at = Math.floor(Date.now() / 1_000);
				let settled = { by: resolver, at: new Date(at * 1_000).toISOString() };
				// The saved answer keeps a snapshot of the matrix: the draft is replaced on reopen.
				let marks = answers[0]?.marks;
				let mutation = room.projectAnswer(stagedDocument, id, projected, settled, chosen, marks);
				// A long answer can push the document past its size limit, after which the
				// Planner can no longer edit it; check the staged copy so a refusal changes nothing.
				try {
					let source = room.project(stagedDocument);
					room.validate(source);
				} catch (err) {
					invalid = err instanceof Error ? err.message : "could not record the answer";
					return;
				}
				let records = new Map(plan.records);
				let answered: Record = {
					...record,
					status: "answered",
					answers: projected,
					resolver,
					at,
					owner: resolver,
					decidedAt: at,
					choices: optionIds,
					...(marks ? { marks } : {}),
					editors: [...new Set([...record.editors, ...claim.entry.editors])],
					anchors: Anchors.answer(record),
				};
				records.set(id, answered);
				answeredRecord = answered;
				let intent = settleIntent(answered);
				let effects = appendFollowupEffect(
					appendProseEffect(
						plan.conversationPlanPendingEffects,
						plan.conversationPlanEffects,
						answered,
					),
					plan.conversationPlanEffects,
					answered,
				);
				let stagedQuestions: Store.Questions = {
					open: new Map(plan.questions.open),
					closed: new Map(plan.questions.closed),
				};
				let complete = Store.stage(stagedQuestions, claim);
				await Service.publishStaged(plan, server, roomId, {
					...plan,
					document: stagedDocument,
					questions: stagedQuestions,
					records,
					conversationPlanPendingEffects: effects,
					...(extras.coordination
						? { coordinationOps: [...plan.coordinationOps, extras.coordination] }
						: {}),
					pendingCardActions: pending(
						plan,
						record,
						{
							kind: "decided",
							id,
							actor: resolver,
							optionIds,
						},
						at,
						answers.map(Question.summarize).join("; "),
					),
				}, mutation);
				finish = complete;
				if (intent) {
					try {
						extras.onCommitted?.(intent);
					} catch (error) {
						console.error("[questions] could not capture saved decision claimant:", error);
					}
				}
			} catch (err) {
				if (err instanceof room.QuestionnaireProjectionError) invalid = err.message;
				else failure = err;
			} finally {
				stagedDocument?.doc.destroy();
			}
		});
	} catch (err) {
		failure = err;
	}
	if (!finish) {
		Store.rollback(plan.questions, claim);
		if (invalid !== undefined) return { ok: false, reason: "invalid", message: invalid };
		return { ok: false, reason: "failure", error: failure };
	}
	return {
		ok: true,
		answers,
		record: answeredRecord!,
		optionIds,
		finish,
	};
}

/** Tell the room a decision resolved: broadcast, announce, re-anchor, record the event. */
function notifyAnswered(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	detail: { id: string; resolver: string; answers: Answer[] },
	event: CardEvent,
): void {
	for (
		let notify of [
			() =>
				broadcast(server, roomId, {
					kind: "question:resolved",
					ts: 0,
					id: detail.id,
					status: "answered",
					resolver: detail.resolver,
					answers: detail.answers,
				}),
			() => announce(plan, server, roomId, detail.id),
			// An answer can put a review on the Planner's list; readers learn its prose is owed.
			() => Service.anchors(plan, server, roomId),
			() => emit(plan, event),
		]
	) {
		try {
			notify();
		} catch (error) {
			console.error("[questions] could not announce a saved decision:", error);
		}
	}
}

export type ExternalAnswerInput = {
	questionId: string;
	/** The shared-draft revision the answer was prepared against. */
	revision: number;
	optionIds: string[];
	/** GitHub login of the allowlisted caller; the identity the answer settles by. */
	resolver: string;
	idempotencyKey: string;
};

export type ExternalAnswer =
	| {
		kind: "answered";
		answers: Answer[];
		settled: { choices: string[]; by: string; at: string };
	}
	| { kind: "replayed"; settled: { choices: string[]; by: string; at: string } }
	| {
		kind: "refused";
		code:
			| "stale"
			| "resolved"
			| "invalid"
			| "draft-in-progress"
			| "paused"
			| "implementation-active"
			| "idempotency-conflict"
			| "state-diverged";
		message?: string;
		current?: number;
	};

/** The complete reviewed request an external answer asks to settle. */
function answerPayloadDigest(input: ExternalAnswerInput): string {
	return createHash("sha256").update(JSON.stringify({
		idempotencyKey: input.idempotencyKey,
		questionId: input.questionId,
		revision: input.revision,
		optionIds: [...input.optionIds],
	})).digest("hex");
}

/**
 * Record a human's answer, asserted by an external coordination caller,
 * through the same durable core as the room's own submit path: the same
 * pre-checks and re-checks, the same staged projection and size check, the
 * same persist-before-broadcast commit, with the B4 operation record riding
 * that commit so the answer and its idempotency ledger cannot diverge.
 */
export async function answerExternal(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	input: ExternalAnswerInput,
): Promise<ExternalAnswer> {
	if (Service.implementationActive(plan)) {
		return { kind: "refused", code: "implementation-active" };
	}
	if (pausedForVerification(plan, input.questionId)) {
		return { kind: "refused", code: "paused" };
	}

	let payloadDigest = answerPayloadDigest(input);
	let fingerprint = coordinationFingerprint({
		idempotencyKey: input.idempotencyKey,
		kind: "answer",
		principal: input.resolver,
		payloadDigest,
	});
	let classified = classifyCoordination(plan.coordinationOps, {
		idempotencyKey: input.idempotencyKey,
		fingerprint,
	});
	if (classified.kind === "replay") {
		let settled = classified.record.result;
		if (!("choices" in settled)) {
			return { kind: "refused", code: "idempotency-conflict" };
		}
		let record = settled;
		return {
			kind: "replayed",
			settled: {
				choices: record.choices,
				by: record.settledBy,
				at: classified.record.committedAt,
			},
		};
	}
	if (classified.kind === "conflict") {
		return { kind: "refused", code: "idempotency-conflict" };
	}

	let claimed = Store.claimAnswer(
		plan.questions,
		input.questionId,
		input.revision,
		input.resolver,
		input.optionIds,
	);
	if (!claimed.ok) {
		if (claimed.reason === "stale") {
			return { kind: "refused", code: "stale", current: claimed.current };
		}
		if (claimed.reason === "resolved") {
			// The store synthesizes "cancelled by system" when the entry is
			// missing entirely. A record that is still open while its entry is
			// gone means this plan's question state has diverged from the
			// document — the claim must say that, not blame a cancellation
			// nobody performed.
			let record = plan.records.get(input.questionId);
			if (
				claimed.status === "cancelled" && claimed.resolver === "system"
				&& record !== undefined && isOpenStatus(record.status)
			) {
				return {
					kind: "refused",
					code: "state-diverged",
					message:
						"the open decision's shared-draft entry is missing from this plan; reopen the document and retry",
				};
			}
			return {
				kind: "refused",
				code: "resolved",
				message: `already ${claimed.status} by ${claimed.resolver}`,
			};
		}
		if (claimed.reason === "draft-in-progress") {
			return { kind: "refused", code: "draft-in-progress" };
		}
		return { kind: "refused", code: "invalid", message: claimed.message };
	}

	let optionIds = claimed.answers.flatMap(answer => answer.optionIds ?? []);
	let committedAt = new Date().toISOString();
	let outcome = await commitAnswer(
		plan,
		server,
		roomId,
		claimed.claim,
		claimed.answers,
		input.resolver,
		{
			coordination: {
				idempotencyKey: input.idempotencyKey,
				kind: "answer",
				fingerprint,
				principal: input.resolver,
				payloadDigest,
				result: { questionId: input.questionId, choices: optionIds, settledBy: input.resolver },
				committedAt,
			},
		},
	);
	if (!outcome.ok) {
		if (outcome.reason === "invalid") {
			return { kind: "refused", code: "invalid", message: outcome.message };
		}
		return {
			kind: "refused",
			code: outcome.error instanceof ConversationCapacityError
					|| outcome.error instanceof Error && outcome.error.message === "implementation is active"
				? "implementation-active"
				: "invalid",
			message: outcome.error instanceof Error ? outcome.error.message : undefined,
		};
	}
	outcome.finish();
	notifyAnswered(plan, server, roomId, {
		id: input.questionId,
		resolver: input.resolver,
		answers: outcome.answers,
	}, {
		kind: "decided",
		id: input.questionId,
		...(outcome.record.threadId ? { threadId: outcome.record.threadId } : {}),
		actor: input.resolver,
		optionIds: outcome.optionIds,
	});
	let settled = { choices: optionIds, by: input.resolver, at: committedAt };
	return { kind: "answered", answers: outcome.answers, settled };
}
