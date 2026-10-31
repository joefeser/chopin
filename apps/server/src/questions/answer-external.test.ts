import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";

import * as Questions from "./service";
import * as Store from "./store";

import { hosted } from "../plan/conversation-persistence.test-fixtures";
import { seededPlan } from "../plan/projection-submit.test-fixtures";

import type { Plan } from "../plan/service";
import type { Socket } from "../wire";

/** A room member's socket, capturing everything sent to it or the room. */
function roomSocket(roomId: string, frames: Array<Record<string, unknown>>): Socket {
	return {
		data: { room: roomId, handle: "octocat", client: "client", canEdit: true },
		send(value: string) {
			frames.push(JSON.parse(value) as Record<string, unknown>);
		},
		publish(_topic: string, value: string) {
			frames.push(JSON.parse(value) as Record<string, unknown>);
		},
		close() {},
	} as unknown as Socket;
}

/** A live room with one open decision card carrying two options. */
async function answerable() {
	let context = await hosted();
	let plan = await seededPlan(context);
	let first = ulid();
	let second = ulid();
	let id = await Questions.insertConversationCard(plan, context.server, context.channel.id, {
		threadId: ulid(),
		header: "Format",
		question: "Which format should the report use?",
		options: [{ id: first, label: "Markdown" }, { id: second, label: "JSON" }],
	});
	let entry = plan.questions.open.get(id);
	if (!entry) throw new Error("card was not open");
	return {
		context,
		plan,
		id,
		first,
		second,
		revision: entry.revision,
		questionId: entry.definition.questions[0]!.id,
	};
}

/** A collaborator's in-flight draft edit, saved to the shared model but not settled. */
function touchDraft(plan: Plan, id: string, questionId: string, optionId: string) {
	let opened = Store.snapshot(plan.questions, id);
	if (!opened.open) throw new Error("question was not open");
	let model = Question.crdt.Model.fromBinary(new Uint8Array(opened.model))
		.fork() as unknown as Question.Model;
	model.api.val([questionId, "choice"]).set(optionId);
	let patch = model.api.flush();
	if (!patch) throw new Error("selection made no patch");
	let edited = Store.edit(plan.questions, id, [...patch.toBinary()], "octocat");
	if (!edited.open || !edited.accepted) throw new Error("could not save the draft choice");
	return edited.revision;
}

/** Submit over the socket the way the room does, optionally after drafting a choice. */
async function submitOverSocket(
	plan: Plan,
	id: string,
	revision: number,
	frames: Array<Record<string, unknown>>,
) {
	await Questions.submit(plan, plan.server, plan.id, roomSocket(plan.id, frames), {
		kind: "question:submit",
		ts: 0,
		rid: ulid(),
		id,
		revision,
	});
}

describe("answerExternal", () => {
	it("settles through the same core as the room's own submit path", async () => {
		let room = await answerable();
		let bridge = await answerable();

		let replies: Array<Record<string, unknown>> = [];
		let drafted = touchDraft(room.plan, room.id, room.questionId, room.first);
		await submitOverSocket(room.plan, room.id, drafted, replies);
		let settledOverSocket = room.plan.records.get(room.id)!;

		let answered = await Questions.answerExternal(
			bridge.plan,
			bridge.plan.server,
			bridge.plan.id,
			{
				questionId: bridge.id,
				revision: bridge.revision,
				optionIds: [bridge.first],
				resolver: "octocat",
				idempotencyKey: "bridge:answer:1",
			},
		);

		expect(replies.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
		if (answered.kind !== "answered") {
			throw new Error(`bridge answer failed: ${JSON.stringify(answered)}`);
		}
		let settledOverBridge = bridge.plan.records.get(bridge.id)!;

		// The same durable outcome, with the caller where the room's handle was.
		for (let record of [settledOverSocket, settledOverBridge]) {
			expect(record.status).toBe("answered");
			expect(record.resolver).toBe("octocat");
			expect(record.owner).toBe("octocat");
			expect(record.choices).toHaveLength(1);
			expect(record.decidedAt).toBeGreaterThan(0);
		}
		expect(settledOverSocket.choices).toEqual([room.first]);
		expect(settledOverBridge.choices).toEqual([bridge.first]);
		expect(answered.settled.by).toBe("octocat");
		expect(answered.settled.choices).toEqual([bridge.first]);
		expect(bridge.plan.questions.open.get(bridge.id)).toBeUndefined();

		// The B4 record rode the settle's own commit.
		expect(bridge.plan.coordinationOps).toHaveLength(1);
		expect(bridge.plan.coordinationOps[0]).toMatchObject({
			idempotencyKey: "bridge:answer:1",
			kind: "answer",
			principal: "octocat",
			result: { questionId: bridge.id, choices: [bridge.first], settledBy: "octocat" },
		});

		// The room heard the bridge settle, as it hears its own.
		expect(
			bridge.context.frames.some(frame =>
				frame.kind === "question:resolved" && frame.id === bridge.id
				&& frame.resolver === "octocat"
			),
		).toBe(true);
	});

	it("refuses a stale revision with the current one, on either path", async () => {
		let room = await answerable();
		let bridge = await answerable();

		let replies: Array<Record<string, unknown>> = [];
		await submitOverSocket(room.plan, room.id, room.revision + 5, replies);
		expect(replies.at(-1)).toMatchObject({
			kind: "question:submit",
			ok: false,
			reason: "stale",
			current: room.revision,
		});
		expect(room.plan.records.get(room.id)!.status).toBe("open");

		let stale = await Questions.answerExternal(bridge.plan, bridge.plan.server, bridge.plan.id, {
			questionId: bridge.id,
			revision: bridge.revision + 5,
			optionIds: [bridge.first],
			resolver: "octocat",
			idempotencyKey: "bridge:stale:1",
		});
		expect(stale).toEqual({ kind: "refused", code: "stale", current: bridge.revision });
		expect(bridge.plan.records.get(bridge.id)!.status).toBe("open");
		expect(bridge.plan.coordinationOps).toHaveLength(0);
	});

	it("refuses once either path settled, and the room's submit agrees", async () => {
		let bridge = await answerable();
		let settled = await Questions.answerExternal(
			bridge.plan,
			bridge.plan.server,
			bridge.plan.id,
			{
				questionId: bridge.id,
				revision: bridge.revision,
				optionIds: [bridge.second],
				resolver: "octocat",
				idempotencyKey: "bridge:answer:2",
			},
		);
		let drafted = bridge.revision;
		if (settled.kind !== "answered") throw new Error("bridge answer failed");

		let again = await Questions.answerExternal(bridge.plan, bridge.plan.server, bridge.plan.id, {
			questionId: bridge.id,
			revision: bridge.revision + 1,
			optionIds: [bridge.first],
			resolver: "octocat",
			idempotencyKey: "bridge:answer:3",
		});
		expect(again).toMatchObject({ kind: "refused", code: "resolved" });

		let replies: Array<Record<string, unknown>> = [];
		await submitOverSocket(bridge.plan, bridge.id, drafted, replies);
		expect(replies.at(-1)).toMatchObject({
			kind: "question:submit",
			ok: false,
			reason: "resolved",
		});
	});

	it("refuses while an implementation is active, on either path", async () => {
		let room = await answerable();
		let bridge = await answerable();
		room.plan.execution = { id: "run-1" } as never;
		bridge.plan.execution = { id: "run-1" } as never;

		let replies: Array<Record<string, unknown>> = [];
		let drafted = touchDraft(room.plan, room.id, room.questionId, room.first);
		await submitOverSocket(room.plan, room.id, drafted, replies);
		expect(JSON.stringify(replies)).toContain("implementation is active");
		expect(room.plan.records.get(room.id)!.status).toBe("open");

		let refused = await Questions.answerExternal(bridge.plan, bridge.plan.server, bridge.plan.id, {
			questionId: bridge.id,
			revision: bridge.revision,
			optionIds: [bridge.first],
			resolver: "octocat",
			idempotencyKey: "bridge:active:1",
		});
		expect(refused).toEqual({ kind: "refused", code: "implementation-active" });
		expect(bridge.plan.records.get(bridge.id)!.status).toBe("open");
	});

	it("refuses a browser draft in progress, which the room's own submit is", async () => {
		let bridge = await answerable();
		let drafted = touchDraft(bridge.plan, bridge.id, bridge.questionId, bridge.first);

		let refused = await Questions.answerExternal(bridge.plan, bridge.plan.server, bridge.plan.id, {
			questionId: bridge.id,
			revision: drafted,
			optionIds: [bridge.second],
			resolver: "octocat",
			idempotencyKey: "bridge:draft:1",
		});
		expect(refused).toEqual({ kind: "refused", code: "draft-in-progress" });
		expect(bridge.plan.records.get(bridge.id)!.status).toBe("open");
		expect(bridge.plan.coordinationOps).toHaveLength(0);
	});

	it("replays an identical retry and refuses a conflicting key reuse", async () => {
		let bridge = await answerable();
		let input = {
			questionId: bridge.id,
			revision: bridge.revision,
			optionIds: [bridge.first],
			resolver: "octocat",
			idempotencyKey: "bridge:answer:9",
		};
		let answered = await Questions.answerExternal(
			bridge.plan,
			bridge.plan.server,
			bridge.plan.id,
			input,
		);
		if (answered.kind !== "answered") throw new Error("bridge answer failed");

		let replayed = await Questions.answerExternal(
			bridge.plan,
			bridge.plan.server,
			bridge.plan.id,
			input,
		);
		expect(replayed).toEqual({ kind: "replayed", settled: answered.settled });
		expect(bridge.plan.coordinationOps).toHaveLength(1);

		let conflict = await Questions.answerExternal(bridge.plan, bridge.plan.server, bridge.plan.id, {
			...input,
			optionIds: [bridge.second],
		});
		expect(conflict).toEqual({ kind: "refused", code: "idempotency-conflict" });
	});
});
