/**
 * The read side of external coordination: a point-in-time view of every
 * decision and the current implementation-graph draft, for an external
 * reviewer that must see the thing under review before approving it.
 *
 * Provenance is load-bearing here. Only documents created through
 * `create_document` carry creation metadata, and only those may be
 * coordinated on; a browser-created document is refused distinctly rather
 * than folded into a generic unavailable, because on the wire the two
 * refusals are otherwise indistinguishable (rehearsal beat 8).
 */

import { definitionDigest, validate } from "./graphs";

import type { Definition, Graph, State } from "./graphs";
import type { Record } from "../questions/records";

/** One settle, current or superseded by a reopen. */
export type CoordinationSettled = {
	choices: string[];
	by: string;
	at?: string;
	answers?: { [questionId: string]: string };
};

export type CoordinationOption = {
	id: string;
	label: string;
	description: string;
	/** The option's own visual, as Markdown. Absent when the option has none. */
	preview?: string;
};

export type CoordinationQuestion = {
	id: string;
	question: string;
	/** Supporting context, shown only in the full decision card. */
	description?: string;
	options: CoordinationOption[];
	/** Whether several options may be chosen; single-select otherwise. */
	multiple: boolean;
	/** Written response; options must be empty. */
	response?: "text";
};

export type CoordinationDecision = {
	id: string;
	status: Record["status"];
	questions: CoordinationQuestion[];
	/** The shared-draft entry revision, while an open questionnaire exists. */
	revision?: number;
	/** The current settle; present while the decision is answered. */
	settled?: CoordinationSettled;
	/** The settle a reopen preserved, as the projection's `<Previous>` does. */
	previous?: CoordinationSettled;
};

export type CoordinationGraph = {
	state: State;
	version: number;
	revision: number;
	planRevision: number;
	/**
	 * The validated definition and its digest, always paired: an external
	 * reviewer reads exactly the bytes the digest covers, which a later
	 * approval proves it reviewed. Absence of the pair is a stop.
	 */
	definition?: Definition;
	digest?: string;
	draftedBy?: string;
	approver?: string;
};

export type CoordinationSnapshot = {
	document: { id: string; title: string; revision: number };
	decisions: CoordinationDecision[];
	graph?: CoordinationGraph;
};

function settled(
	choices: string[] | undefined,
	by: string | undefined,
	at: number | undefined,
	answers: { [questionId: string]: string } | undefined,
): CoordinationSettled | undefined {
	if (by === undefined) return undefined;
	return {
		choices: choices ?? [],
		by,
		...(at !== undefined ? { at: new Date(at * 1_000).toISOString() } : {}),
		...(answers && Object.keys(answers).length ? { answers } : {}),
	};
}

/**
 * Assemble the snapshot. Returns `undefined` when the document lacks MCP
 * provenance: the caller reports that as a refusal of its own kind, never
 * as a plain missing document.
 */
export function coordinationSnapshot(input: {
	channel: { id: string; title: string };
	revision: number;
	/** Present only on documents created through `create_document`. */
	creation?: unknown;
	records: Iterable<Record>;
	/** Open questionnaire entries; their revisions are the answer token. */
	openQuestions: Iterable<{ id: string; revision: number }>;
	graph?: Graph;
}): CoordinationSnapshot | undefined {
	if (input.creation === undefined) return undefined;

	let open = new Map<string, number>();
	for (let entry of input.openQuestions) open.set(entry.id, entry.revision);

	let decisions: CoordinationDecision[] = [];
	for (let record of input.records) {
		let prior = record.history.at(-1);
		decisions.push({
			id: record.id,
			status: record.status,
			questions: record.definition.questions.map(question => ({
				id: question.id,
				question: question.question,
				...(question.description !== undefined
					? { description: question.description }
					: {}),
				options: question.options.map(option => ({
					id: option.id,
					label: option.label,
					description: option.description,
					...(option.preview !== undefined ? { preview: option.preview } : {}),
				})),
				multiple: question.multiple,
				...(question.response !== undefined ? { response: question.response } : {}),
			})),
			...(open.has(record.id) ? { revision: open.get(record.id)! } : {}),
			...(record.status === "answered" && record.resolver !== undefined
				? {
					settled: settled(
						record.choices,
						record.resolver,
						record.decidedAt ?? record.at,
						record.answers,
					),
				}
				: {}),
			...(prior
				? { previous: settled(prior.choices, prior.owner, prior.at, prior.answers) }
				: {}),
		});
	}

	let current = input.graph?.versions.at(-1);
	let graph: CoordinationGraph | undefined;
	if (current) {
		let checked = validate(current.definition);
		graph = {
			state: current.state,
			version: current.number,
			revision: current.revision,
			planRevision: current.planRevision,
			...(checked.ok
				? { definition: checked.value, digest: definitionDigest(checked.value) }
				: {}),
			...(current.draftedBy !== undefined ? { draftedBy: current.draftedBy } : {}),
			...(current.approver !== undefined ? { approver: current.approver } : {}),
		};
	}

	return {
		document: {
			id: input.channel.id,
			title: input.channel.title,
			revision: input.revision,
		},
		decisions,
		...(graph ? { graph } : {}),
	};
}
