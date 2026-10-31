import { describe, expect, it } from "bun:test";

import { coordinationSnapshot } from "./coordination-snapshot";
import { definitionDigest } from "./graphs";

import type { CoordinationQuestion, CoordinationSnapshot } from "./coordination-snapshot";
import type { Definition, Graph } from "./graphs";
import type { Record } from "../questions/records";

let channel = { id: "2fe799da-bb29-5845-8555-7498b2582dc8", title: "Release readiness" };

/** A multi-select question with option context, beside a written-response one. */
let definition: Record["definition"] = {
	questions: [
		{
			id: "q-format",
			header: "Which formats may the report mix?",
			question: "Which formats may the report mix?",
			description: "More than one may be chosen; prose stays out of the report.",
			options: [
				{
					id: "01M696N0PQ",
					label: "Markdown",
					description: "Prose and diagrams that reviewers can quote.",
					preview: "```mermaid\ngraph TD\n```\n",
				},
				{
					id: "01M696N0PR",
					label: "JSON",
					description: "A machine-checkable schema of the same content.",
				},
			],
			multiple: true,
		},
		{
			id: "q-why",
			header: "Why that mix?",
			question: "Why that mix?",
			options: [],
			multiple: false,
			response: "text",
		},
	],
};

let open: Record = {
	id: "01M696N0PQQNQS9HJYXMJ5PJHR",
	definition,
	status: "open",
	origin: "conversation",
	history: [],
	optionOrigins: {},
	editors: [],
};

let answered: Record = {
	...open,
	id: "01M696N0PQQNQS9HJYXMJ5PJHR01",
	status: "answered",
	resolver: "joefeser",
	owner: "joefeser",
	at: 1_793_433_600,
	decidedAt: 1_793_433_600,
	choices: ["01M696N0PQ"],
	answers: { "q-why": "Markdown quotes cleanly in review." },
};

let reopened: Record = {
	...open,
	id: "01M696N0PQQNQS9HJYXMJ5PJHR02",
	status: "reopened",
	history: [{
		choices: ["01M696N0PR"],
		owner: "joefeser",
		at: 1_793_425_600,
	}],
};

let tasks: Definition = {
	tasks: [{
		id: "model",
		title: "Model the graph",
		context: "The graph is durable document state.",
		goal: "Define versioned task graphs.",
		acceptance: ["The graph has versions.", "Versions retain their plan revision."],
		dependsOn: [],
	}],
};

let graph: Graph = {
	versions: [{
		number: 2,
		revision: 3,
		planRevision: 37,
		state: "draft",
		definition: tasks,
		draftedBy: "script",
	}],
};

function snapshot(): CoordinationSnapshot | undefined {
	return coordinationSnapshot({
		channel,
		revision: 37,
		creation: { origin: { idempotencyKey: "bridge-create-1" } },
		records: [open, answered, reopened],
		openQuestions: [{ id: open.id, revision: 5 }, { id: reopened.id, revision: 0 }],
		graph,
	});
}

/** What every decision exposes, answer semantics and option context intact. */
let exposedQuestions: CoordinationQuestion[] = [
	{
		id: "q-format",
		question: "Which formats may the report mix?",
		description: "More than one may be chosen; prose stays out of the report.",
		options: [
			{
				id: "01M696N0PQ",
				label: "Markdown",
				description: "Prose and diagrams that reviewers can quote.",
				preview: "```mermaid\ngraph TD\n```\n",
			},
			{
				id: "01M696N0PR",
				label: "JSON",
				description: "A machine-checkable schema of the same content.",
			},
		],
		multiple: true,
	},
	{ id: "q-why", question: "Why that mix?", options: [], multiple: false, response: "text" },
];

describe("coordinationSnapshot", () => {
	it("exposes every decision with its settle, its prior settle, and the draft graph", () => {
		expect(snapshot()).toEqual({
			document: { id: channel.id, title: channel.title, revision: 37 },
			decisions: [
				{
					id: open.id,
					status: "open",
					questions: exposedQuestions,
					revision: 5,
				},
				{
					id: answered.id,
					status: "answered",
					questions: exposedQuestions,
					settled: {
						choices: ["01M696N0PQ"],
						by: "joefeser",
						at: new Date(1_793_433_600 * 1_000).toISOString(),
						answers: { "q-why": "Markdown quotes cleanly in review." },
					},
				},
				{
					id: reopened.id,
					status: "reopened",
					questions: exposedQuestions,
					revision: 0,
					previous: {
						choices: ["01M696N0PR"],
						by: "joefeser",
						at: new Date(1_793_425_600 * 1_000).toISOString(),
					},
				},
			],
			graph: {
				state: "draft",
				version: 2,
				revision: 3,
				planRevision: 37,
				definition: tasks,
				digest: definitionDigest(tasks),
				draftedBy: "script",
			},
		});
	});

	it("refuses a document without MCP provenance", () => {
		let outcome = coordinationSnapshot({
			channel,
			revision: 4,
			records: [],
			openQuestions: [],
		});
		expect(outcome).toBeUndefined();
	});

	it("digests stably across two reads, always over the definition it returns", () => {
		let first = snapshot();
		let second = snapshot();
		expect(first?.graph?.digest).toBe(second?.graph?.digest);
		expect(first).toEqual(second);
		expect(first?.graph?.definition).toEqual(tasks);
		// The pairing an approval later proves: the digest covers exactly the
		// definition the reviewer read, never a separate serialization.
		if (first?.graph?.definition) {
			expect(first.graph.digest).toBe(definitionDigest(first.graph.definition));
		}
		expect(first?.graph?.digest).toBe(definitionDigest(tasks));
	});

	it("omits the graph before one exists and its definition when it does not validate", () => {
		let before = coordinationSnapshot({
			channel,
			revision: 4,
			creation: { origin: { idempotencyKey: "bridge-create-1" } },
			records: [],
			openQuestions: [],
		});
		expect(before).toEqual({
			document: { id: channel.id, title: channel.title, revision: 4 },
			decisions: [],
		});

		let invalid: Graph = {
			versions: [{
				number: 1,
				revision: 1,
				planRevision: 4,
				state: "draft",
				definition: {
					tasks: [{
						id: "model",
						title: "Model",
						context: "Context",
						goal: "Goal",
						acceptance: ["First.", "Second."],
						dependsOn: ["missing-task"],
					}],
				},
			}],
		};
		let unreadable = coordinationSnapshot({
			channel,
			revision: 4,
			creation: { origin: { idempotencyKey: "bridge-create-1" } },
			records: [],
			openQuestions: [],
			graph: invalid,
		});
		expect(unreadable).toEqual({
			document: { id: channel.id, title: channel.title, revision: 4 },
			decisions: [],
			graph: { state: "draft", version: 1, revision: 1, planRevision: 4 },
		});
	});
});
