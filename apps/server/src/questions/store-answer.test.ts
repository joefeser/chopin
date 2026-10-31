import { describe, expect, it } from "bun:test";
import * as Question from "@chopin/question";

import * as Store from "./store";

function card(
	id: string,
	questions: Array<{
		multiple: boolean;
		response?: "text";
		options: string[];
		criteria?: string[];
	}>,
) {
	let definition = Question.decision({
		questions: questions.map((question, index) => ({
			id: `q${index}`,
			header: `Decision ${index}`,
			question: `What should decision ${index} be?`,
			multiple: question.multiple,
			...(question.response ? { response: question.response } : {}),
			...(question.criteria
				? { criteria: question.criteria.map(id => ({ id, label: id })) }
				: {}),
			options: question.options.map(option => ({ id: option, label: option, description: "" })),
		})),
	});
	let all = Store.create();
	void Store.ask(all, id, definition, id);
	return all;
}

/** Touch a question's shared draft with a real edit patch, as a collaborator would. */
function touch(questions: Store.Questions, id: string, choice: string) {
	let entry = Store.get(questions, id)!;
	let model = Question.crdt.Model.fromBinary(entry.model.toBinary())
		.fork() as unknown as Question.Model;
	model.api.val(["q0", "choice"]).set(choice);
	let patch = model.api.flush();
	if (!patch) throw new Error("selection made no patch");
	let edited = Store.edit(questions, id, [...patch.toBinary()], "ana");
	if (!edited.open || !edited.accepted || !edited.applied) throw new Error("could not touch draft");
}

/** Mark one criterion cell, as a collaborator judging the matrix would. */
function mark(questions: Store.Questions, id: string, cell: string, value: "yes" | null) {
	let entry = Store.get(questions, id)!;
	let model = Question.crdt.Model.fromBinary(entry.model.toBinary())
		.fork() as unknown as Question.Model;
	let cells = model.api.obj(["q0", "marks"]);
	if (Object.hasOwn(cells.view() as object, cell)) model.api.val(["q0", "marks", cell]).set(value);
	else cells.set({ [cell]: Question.crdt.schema.val(Question.crdt.schema.con(value)) });
	let patch = model.api.flush();
	if (!patch) throw new Error("mark made no patch");
	let edited = Store.edit(questions, id, [...patch.toBinary()], "ana");
	if (!edited.open || !edited.accepted || !edited.applied) {
		throw new Error("could not save the mark");
	}
}

describe("Store.claimAnswer", () => {
	it("reserves a single answer built from the supplied option, not the shared draft", () => {
		let questions = card("w", [{ multiple: false, options: ["a", "b"] }]);
		let claimed = Store.claimAnswer(questions, "w", 0, "octocat", ["b"]);
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		expect(claimed.answers).toHaveLength(1);
		expect(claimed.answers[0]).toMatchObject({ optionIds: ["b"] });
		expect(claimed.claim.result).toMatchObject({ status: "answered", resolver: "octocat" });
		expect(Store.get(questions, "w")!.claim).toBe("submit");
		Store.rollback(questions, claimed.claim);
		expect(Store.get(questions, "w")!.claim).toBeUndefined();
	});

	it("reserves a multi-select answer with every supplied option", () => {
		let questions = card("w", [{ multiple: true, options: ["a", "b", "c"] }]);
		let claimed = Store.claimAnswer(questions, "w", 0, "octocat", ["a", "c"]);
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		expect(claimed.answers[0]).toMatchObject({ optionIds: ["a", "c"] });
		Store.rollback(questions, claimed.claim);
	});

	it("refuses a stale revision with the current one, like a shared-draft submit", () => {
		let questions = card("w", [{ multiple: false, options: ["a"] }]);
		expect(Store.claimAnswer(questions, "w", 1, "octocat", ["a"])).toEqual({
			ok: false,
			reason: "stale",
			current: 0,
		});
	});

	it("refuses when the decision already settled, naming how", () => {
		let questions = card("w", [{ multiple: false, options: ["a"] }]);
		let first = Store.claimAnswer(questions, "w", 0, "octocat", ["a"]);
		if (!first.ok) throw new Error("first answer was not claimable");
		Store.commit(questions, first.claim);
		expect(Store.claimAnswer(questions, "w", 1, "octocat", ["a"])).toMatchObject({
			ok: false,
			reason: "resolved",
			status: "answered",
			resolver: "octocat",
		});
	});

	it("refuses draft-in-progress when a collaborator has unsaved edits", () => {
		let questions = card("w", [{ multiple: false, options: ["a", "b"] }]);
		touch(questions, "w", "a");
		expect(Store.claimAnswer(questions, "w", 1, "octocat", ["b"])).toEqual({
			ok: false,
			reason: "draft-in-progress",
		});
	});

	it("refuses unknown options, doubled single answers, and unanswered cards", () => {
		let questions = card("w", [{ multiple: false, options: ["a", "b"] }]);
		let unknown = Store.claimAnswer(questions, "w", 0, "octocat", ["nope"]);
		expect(unknown).toMatchObject({ ok: false, reason: "invalid", message: "Unknown option nope" });
		let doubled = Store.claimAnswer(questions, "w", 0, "octocat", ["a", "b"]);
		expect(doubled).toMatchObject({
			ok: false,
			reason: "invalid",
			message: "Decision 0 accepts only one answer",
		});
		let empty = Store.claimAnswer(questions, "w", 0, "octocat", []);
		expect(empty).toMatchObject({ ok: false, reason: "invalid" });
	});

	it("refuses a draft whose only work is active criterion marks", () => {
		let questions = card("w", [{ multiple: false, options: ["a", "b"], criteria: ["care"] }]);
		mark(questions, "w", Question.markKey("a", "care"), "yes");
		expect(
			Store.claimAnswer(questions, "w", Store.get(questions, "w")!.revision, "octocat", ["b"]),
		).toEqual({ ok: false, reason: "draft-in-progress" });
		// Cleared marks leave nothing active; the settle may proceed.
		mark(questions, "w", Question.markKey("a", "care"), null);
		let claimed = Store.claimAnswer(
			questions,
			"w",
			Store.get(questions, "w")!.revision,
			"octocat",
			["b"],
		);
		expect(claimed.ok).toBe(true);
		if (claimed.ok) Store.rollback(questions, claimed.claim);
	});

	it("refuses a written-response card, which no option can answer", () => {
		let questions = card("w", [{ multiple: false, response: "text", options: [] }]);
		expect(Store.claimAnswer(questions, "w", 0, "octocat", ["any"])).toMatchObject({
			ok: false,
			reason: "invalid",
			message: "Unknown option any",
		});
		expect(Store.claimAnswer(questions, "w", 0, "octocat", [])).toMatchObject({
			ok: false,
			reason: "invalid",
		});
	});
});
