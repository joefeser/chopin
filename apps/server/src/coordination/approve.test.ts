import { describe, expect, it } from "bun:test";

import { approveExternal } from "./approve";
import { definitionDigest, validate } from "../tasks/graphs";
import { implementationGraphs } from "../tasks/plan-graphs";
import { hosted as room } from "../plan/conversation-persistence.test-fixtures";
import { seededPlan } from "../plan/projection-submit.test-fixtures";

import type { ExternalApprovalInput } from "./approve";

function tasks() {
	return [{
		id: "draft",
		title: "Draft the report",
		context: "The report is the document this graph implements.",
		goal: "Write the report the decision settled on.",
		acceptance: ["The report exists.", "It names the chosen format."],
		dependsOn: [],
	}];
}

/** A plan with one scripted draft, and the review input that matches it. */
async function reviewable() {
	let context = await room();
	let plan = await seededPlan(context);
	let result = await implementationGraphs().revise(plan, {
		planRevision: plan.revision,
		graphRevision: 0,
		operations: tasks().map(task => ({ op: "add" as const, task })),
		draftedBy: "script",
	});
	if (!result.ok) throw new Error(`could not draft: ${result.reason}`);
	let version = plan.graph!.versions.at(-1)!;
	let checked = validate(version.definition);
	if (!checked.ok) throw new Error(`the drafted definition is invalid: ${checked.reason}`);
	let digest = definitionDigest(checked.value);
	return {
		context,
		plan,
		input: {
			graphVersion: version.number,
			graphRevision: version.revision,
			planRevision: version.planRevision,
			digest,
			idempotencyKey: "bridge:approve:1",
			approver: "octocat",
		} satisfies ExternalApprovalInput,
	};
}

describe("approveExternal", () => {
	it("approves exactly the reviewed bytes, stamped and recorded", async () => {
		let review = await reviewable();
		let outcome = await approveExternal(review.plan, review.input);
		if (outcome.kind !== "approved") {
			throw new Error(`approval failed: ${JSON.stringify(outcome)}`);
		}
		expect(outcome.graph).toEqual({
			state: "approved",
			version: 1,
			revision: 1,
			planRevision: review.input.planRevision,
			approver: "octocat",
			operationKey: "bridge:approve:1",
		});
		let version = review.plan.graph!.versions.at(-1)!;
		expect(version.state).toBe("approved");
		expect(version).toMatchObject({ approver: "octocat", operationKey: "bridge:approve:1" });
		expect(review.plan.coordinationOps).toHaveLength(1);
		expect(review.plan.coordinationOps[0]).toMatchObject({
			kind: "approve",
			principal: "octocat",
			result: { graphVersion: 1, graphRevision: 1, approver: "octocat" },
		});
	});

	it("settles two identical approvals racing on the queue as approve and replay", async () => {
		let review = await reviewable();
		let [first, second] = await Promise.all([
			approveExternal(review.plan, review.input),
			approveExternal(review.plan, { ...review.input }),
		]);
		let kinds = [first.kind, second.kind].sort();
		expect(kinds).toEqual(["approved", "replayed"]);
		expect(review.plan.coordinationOps).toHaveLength(1);
		if (first.kind === "approved" && second.kind === "replayed") {
			expect(second.graph).toEqual(first.graph);
		} else if (first.kind === "replayed" && second.kind === "approved") {
			expect(first.graph).toEqual(second.graph);
		} else {
			throw new Error(`race produced ${kinds.join(", ")}`);
		}
	});

	it("replays an identical retry and refuses a conflicting key reuse", async () => {
		let review = await reviewable();
		let approved = await approveExternal(review.plan, review.input);
		if (approved.kind !== "approved") throw new Error("approval failed");

		let replayed = await approveExternal(review.plan, review.input);
		expect(replayed).toEqual({ kind: "replayed", graph: approved.graph });

		let conflict = await approveExternal(review.plan, {
			...review.input,
			digest: "0".repeat(64),
		});
		expect(conflict).toMatchObject({ kind: "refused", code: "idempotency-conflict" });
	});

	it("refuses a moved plan and a revised draft by their own codes", async () => {
		let stale = await reviewable();
		stale.plan.revision += 1;
		expect(await approveExternal(stale.plan, stale.input)).toEqual({
			kind: "refused",
			code: "stale-plan",
		});

		let changed = await reviewable();
		let revised = await implementationGraphs().revise(changed.plan, {
			planRevision: changed.plan.revision,
			graphRevision: 1,
			operations: [{ op: "add", task: { ...tasks()[0]!, id: "second" } }],
			draftedBy: "script",
		});
		if (!revised.ok) throw new Error("could not revise the draft");
		expect(await approveExternal(changed.plan, changed.input)).toEqual({
			kind: "refused",
			code: "reviewed-graph-changed",
		});

		let mismatch = await reviewable();
		expect(
			await approveExternal(mismatch.plan, { ...mismatch.input, digest: "f".repeat(64) }),
		).toEqual({ kind: "refused", code: "digest-mismatch" });
	});

	it("refuses an open decision by either status, naming the decision", async () => {
		let open = await reviewable();
		open.plan.records.set("01M696N0", {
			id: "01M696N0",
			definition: { questions: [] },
			status: "open",
			origin: "conversation",
			history: [],
			optionOrigins: {},
			editors: [],
		});
		expect(await approveExternal(open.plan, open.input)).toEqual({
			kind: "refused",
			code: "open-decision",
			openDecisions: ["01M696N0"],
		});

		// The helper checks only "open"; a reopened decision must refuse here.
		let reopened = open.plan.records.get("01M696N0")!;
		reopened.status = "reopened";
		expect(await approveExternal(open.plan, open.input)).toEqual({
			kind: "refused",
			code: "open-decision",
			openDecisions: ["01M696N0"],
		});
	});

	it("refuses missing graphs, active implementations, and non-draft states", async () => {
		let empty = await reviewable();
		empty.plan.graph = undefined;
		expect(await approveExternal(empty.plan, empty.input)).toEqual({
			kind: "refused",
			code: "missing",
		});

		let active = await reviewable();
		active.plan.execution = { id: "run-1" } as never;
		expect(await approveExternal(active.plan, active.input)).toEqual({
			kind: "refused",
			code: "implementation-active",
		});

		let locked = await reviewable();
		let version = locked.plan.graph!.versions.at(-1)!;
		locked.plan.graph!.versions[locked.plan.graph!.versions.length - 1] = {
			...version,
			state: "locked",
		};
		// Any non-draft state — approved, locked, superseded — is one refusal.
		expect(await approveExternal(locked.plan, locked.input)).toMatchObject({
			kind: "refused",
			code: "not-draft",
		});

		let browser = await reviewable();
		let approved = await implementationGraphs().approve(browser.plan);
		if (!approved.ok) throw new Error("could not approve");
		// A browser approval is not this operation's to replay.
		expect(await approveExternal(browser.plan, browser.input)).toMatchObject({
			kind: "refused",
			code: "not-draft",
		});
	});

	it("keeps the plan unchanged when the durable half fails", async () => {
		let review = await reviewable();
		let persistence = review.plan.persistence as { lease: () => unknown };
		let lease = persistence.lease;
		persistence.lease = () => {
			throw new Error("storage is down");
		};
		let outcome = await approveExternal(review.plan, review.input);
		persistence.lease = lease;
		expect(outcome).toMatchObject({ kind: "refused", code: "durability" });
		let version = review.plan.graph!.versions.at(-1)!;
		expect(version.state).toBe("draft");
		expect(version.approver).toBeUndefined();
		expect(review.plan.coordinationOps).toHaveLength(0);
	});
});
