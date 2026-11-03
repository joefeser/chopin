/**
 * D6: external coordination state must survive the room's own concurrent
 * publications, and late claims must name what actually happened.
 *
 * Born from the Part B rehearsal (2026-10-31): after an external scripted
 * draft committed, the live room's publications left the external graph and
 * the open questionnaire entry invisible to every external read, and a late
 * claim against a settled card reported "cancelled by system" though nothing
 * was cancelled. These tests pin the interleavings in both orders.
 */

import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";

import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import * as Room from "../plan/room";
import { hosted as room } from "../plan/conversation-persistence.test-fixtures";
import { seededPlan } from "../plan/projection-submit.test-fixtures";
import * as Service from "../plan/service";
import { implementationGraphs } from "../tasks/plan-graphs";
import { definitionDigest, validate } from "../tasks/graphs";

function task(id: string) {
	return {
		id,
		title: `Task ${id}`,
		context: "The release ships one export format per the settled decision.",
		goal: "Implement the exporter for the settled format.",
		acceptance: ["The exporter emits the settled format.", "Every settled section is included."],
		dependsOn: [] as string[],
	};
}

/** A live plan with one open card, its title key enabled as a hosted open would. */
async function cardPlan() {
	let context = await room();
	let plan = await seededPlan(context);
	Room.enableTitle(plan.document, "Release export format");
	let optionId = ulid();
	let id = await Questions.insertConversationCard(plan, context.server, context.channel.id, {
		threadId: ulid(),
		header: "Format",
		question: "Which format should the report use?",
		options: [{ id: optionId, label: "Markdown" }, { id: ulid(), label: "JSON" }],
	});
	let entry = Store.get(plan.questions, id);
	if (!entry) throw new Error("card was not open");
	let questionId = plan.records.get(id)?.definition.questions[0]?.id;
	if (!questionId) throw new Error("card had no question");
	return { context, plan, id, questionId, optionId, revision: entry.revision };
}

/** The external scripted draft, exactly as the coordination route drives it. */
async function scriptDraft(plan: Service.Plan) {
	let current = plan.graph?.versions.at(-1);
	let drafted = await implementationGraphs().revise(plan, {
		planRevision: plan.revision,
		graphRevision: current?.revision ?? 0,
		operations: [
			...(current?.definition.tasks ?? []).map(existing => ({
				op: "remove" as const,
				id: existing.id,
			})),
			{ op: "add" as const, task: task("export-writer") },
		],
		draftedBy: "script",
	});
	if (!drafted.ok) throw new Error(`scripted draft refused: ${drafted.reason}`);
}

describe("external coordination state under concurrent room publications (D6)", () => {
	it("keeps the external graph when a Planner option addition publishes after it", async () => {
		let state = await cardPlan();
		try {
			await scriptDraft(state.plan);
			let committed = state.plan.graph!.versions.at(-1)!;
			let checked = validate(committed.definition);
			if (!checked.ok) throw new Error("drafted definition is invalid");
			let digest = definitionDigest(checked.value);
			// The suggest turn's write: an option added through the questions
			// service after the external commit landed.
			let added = await Questions.addServerOption(
				state.plan,
				state.plan.server,
				state.context.channel.id,
				state.id,
				{ label: "Plain text", origin: "planner" },
				true,
			);
			if (!added.ok) throw new Error(`option addition refused: ${added.reason}`);

			// The live view keeps the exact draft the bridge committed.
			let published = state.plan.graph?.versions.at(-1);
			expect(published).toMatchObject({
				number: committed.number,
				revision: committed.revision,
				planRevision: committed.planRevision,
				state: committed.state,
				draftedBy: "script",
			});
			let publishedChecked = published && validate(published.definition);
			if (!publishedChecked?.ok) throw new Error("published draft definition is invalid");
			expect(definitionDigest(publishedChecked.value)).toBe(digest);
			// And so does the persisted sidecar, after a cold reopen.
			await Service.close(state.plan);
			let reopened = await Service.open(
				state.context.channel.id,
				state.context.backend,
				state.context.server,
			);
			try {
				let restored = reopened.graph?.versions.at(-1);
				expect(restored).toMatchObject({
					number: committed.number,
					revision: committed.revision,
					planRevision: committed.planRevision,
					state: committed.state,
					draftedBy: "script",
				});
				let restoredChecked = restored && validate(restored.definition);
				if (!restoredChecked?.ok) throw new Error("reopened draft definition is invalid");
				expect(definitionDigest(restoredChecked.value)).toBe(digest);
			} finally {
				await Service.close(reopened);
			}
		} finally {
			await Service.close(state.plan).catch(() => {});
		}
	});

	it("keeps the open entry claimable across the same interleaving", async () => {
		let state = await cardPlan();
		try {
			await scriptDraft(state.plan);
			let added = await Questions.addServerOption(
				state.plan,
				state.plan.server,
				state.context.channel.id,
				state.id,
				{ label: "Plain text", origin: "planner" },
				true,
			);
			if (!added.ok) throw new Error(`option addition refused: ${added.reason}`);
			let entry = Store.get(state.plan.questions, state.id);
			if (!entry) throw new Error("open entry vanished after the option publication");

			let answered = await Questions.answerExternal(
				state.plan,
				state.plan.server,
				state.context.channel.id,
				{
					questionId: state.id,
					revision: entry.revision,
					optionIds: [state.optionId],
					resolver: "octocat",
					idempotencyKey: "d6:answer:1",
				},
			);
			if (answered.kind === "refused") {
				throw new Error(`external answer refused: ${JSON.stringify(answered)}`);
			}
			expect(answered.kind).toBe("answered");
		} finally {
			await Service.close(state.plan).catch(() => {});
		}
	});

	it("names the resolver when a late claim meets an already-settled card", async () => {
		let state = await cardPlan();
		try {
			let answered = await Questions.answerExternal(
				state.plan,
				state.plan.server,
				state.context.channel.id,
				{
					questionId: state.id,
					revision: state.revision,
					optionIds: [state.optionId],
					resolver: "octocat",
					idempotencyKey: "d6:answer:2",
				},
			);
			if (answered.kind !== "answered") {
				throw new Error(`first answer was not settled: ${JSON.stringify(answered)}`);
			}
			// The live settle's own answer set — in derive's shape, the question
			// text with labels and ids, never a custom summary.
			let question = state.plan.records.get(state.id)!.definition.questions[0]!;
			expect(answered.answers).toEqual([{
				question: question.question,
				choices: ["Markdown"],
				optionIds: [state.optionId],
			}]);
			await Service.close(state.plan);

			// A fresh open models every later reader: the room after an
			// eviction, the bridge after a restart. The entry is no longer
			// open — a claim must say who settled it, not that the system
			// cancelled it.
			let reopened = await Service.open(
				state.context.channel.id,
				state.context.backend,
				state.context.server,
			);
			try {
				let late = await Questions.answerExternal(
					reopened,
					reopened.server,
					state.context.channel.id,
					{
						questionId: state.id,
						revision: state.revision,
						optionIds: [state.optionId],
						resolver: "octocat",
						idempotencyKey: "d6:answer:3",
					},
				);
				expect(late).toMatchObject({
					kind: "refused",
					code: "resolved",
					message: "already answered by octocat",
				});

				// The seeded tombstone carries the durable answers, so a late
				// submit's refusal reads exactly like the settle it just
				// missed — the complete answer set, field for field.
				let lateSubmit = Store.claimSubmit(
					reopened.questions,
					state.id,
					state.revision,
					"hubot",
				);
				if (lateSubmit.ok || lateSubmit.reason !== "resolved") {
					throw new Error(`late submit was not resolved: ${JSON.stringify(lateSubmit)}`);
				}
				expect(lateSubmit.status).toBe("answered");
				expect(lateSubmit.resolver).toBe("octocat");
				expect(lateSubmit.answers).toEqual(answered.answers);
			} finally {
				await Service.close(reopened);
			}
		} finally {
			await Service.close(state.plan).catch(() => {});
		}
	});

	it("names the divergence when an open card's entry is missing from the plan", async () => {
		let state = await cardPlan();
		try {
			// The split-brain signature from the rehearsal: the record says
			// open, but the shared-draft entry is gone from this instance.
			state.plan.questions.open.delete(state.id);
			let diverged = await Questions.answerExternal(
				state.plan,
				state.plan.server,
				state.context.channel.id,
				{
					questionId: state.id,
					revision: state.revision,
					optionIds: [state.optionId],
					resolver: "octocat",
					idempotencyKey: "d6:answer:4",
				},
			);
			expect(diverged).toMatchObject({
				kind: "refused",
				code: "state-diverged",
			});
		} finally {
			await Service.close(state.plan).catch(() => {});
		}
	});

	it("answers honestly when a mis-keyed late claim meets a settled card", async () => {
		// The rehearsal's exact shape (run 2, finding D7): the caller names
		// the question inside the card instead of the card itself, and the
		// card was already settled through the room's own path. Whatever the
		// plan's entry maps hold, the durable record is the truth a claim
		// must meet — the refusal names the settle, never a cancellation
		// nobody performed.
		let state = await cardPlan();
		try {
			let first = await Questions.answerExternal(
				state.plan,
				state.plan.server,
				state.context.channel.id,
				{
					questionId: state.id,
					revision: state.revision,
					optionIds: [state.optionId],
					resolver: "octocat",
					idempotencyKey: "d7:answer:1",
				},
			);
			if (first.kind !== "answered") {
				throw new Error(`first answer failed: ${JSON.stringify(first)}`);
			}
			// Strip every entry: whatever happened to this instance's maps,
			// the answered record survives.
			state.plan.questions.open.delete(state.id);
			state.plan.questions.closed.delete(state.id);
			let late = await Questions.answerExternal(
				state.plan,
				state.plan.server,
				state.context.channel.id,
				{
					questionId: state.questionId,
					revision: state.revision,
					optionIds: [state.optionId],
					resolver: "octocat",
					idempotencyKey: "d7:answer:2",
				},
			);
			expect(late).toMatchObject({
				kind: "refused",
				code: "resolved",
				message: "already answered by octocat",
			});
		} finally {
			await Service.close(state.plan).catch(() => {});
		}
	});
});
