import { describe, expect, it } from "bun:test";

import { hosted as roomsHosted } from "./hosted";
import * as Room from "../plan/room";
import { hosted as room } from "../plan/conversation-persistence.test-fixtures";
import { seededPlan } from "../plan/projection-submit.test-fixtures";

import * as Service from "../plan/service";

import type { HostedAuth } from "../auth/routes";
import type { GitHubUser } from "../github/client";

/** Hosted authentication over the in-memory room fixture, for the MCP adapter. */
function authority(context: Awaited<ReturnType<typeof room>>): HostedAuth {
	return {
		config: { origin: "http://chopin.test" },
		storage: context.storage,
		github: {
			async repository(_token: string, owner: string, name: string) {
				if (owner !== "octo-org" || name !== "score") throw new Error("unknown repository");
				return {
					id: "R_score",
					owner,
					name,
					permissions: { pull: true, push: true, admin: false },
				};
			},
		},
		admission: {},
		sessions: {},
		machines: {},
		pairings: {},
		clock: () => context.now,
	} as unknown as HostedAuth;
}

function caller(login: string) {
	return {
		oauthToken: "token",
		user: { id: `U_${login}`, login } as GitHubUser,
	};
}

describe("hosted coordination approving", () => {
	/** A cold document with one scripted draft, and the hosted options over it. */
	async function reviewable() {
		let context = await room();
		let plan = await seededPlan(context);
		// The bridge only reads MCP-created documents; give this one the
		// creation metadata create_document would have persisted.
		// Give the document its title key before drafting, as a hosted open
		// would, so later cold opens do not normalize and move the plan out
		// from under the drafted graph's plan revision.
		Room.enableTitle(plan.document, "Release readiness");
		plan.creation = {
			brief: {
				goal: "Demonstrate the coordination loop.",
				constraints: [],
				settledDecisions: [],
				openQuestions: [],
				repositoryFindings: [],
			},
			origin: {
				idempotencyKey: "seed:approve:1",
				fingerprint: "0".repeat(64),
				repository: "octo-org/score",
				baseBranch: "main",
				baseCommit: "abc123",
				title: "Release readiness",
			},
		};
		let { definitionDigest, validate } = await import("../tasks/graphs");
		let { implementationGraphs } = await import("../tasks/plan-graphs");
		let drafted = await implementationGraphs().revise(plan, {
			planRevision: plan.revision,
			graphRevision: 0,
			operations: [{
				op: "add",
				task: {
					id: "draft",
					title: "Draft the report",
					context: "The report is the document this graph implements.",
					goal: "Write the report the decision settled on.",
					acceptance: ["The report exists.", "It names the chosen format."],
					dependsOn: [],
				},
			}],
			draftedBy: "script",
		});
		if (!drafted.ok) throw new Error(`could not draft: ${drafted.reason}`);
		let version = plan.graph!.versions.at(-1)!;
		let checked = validate(version.definition);
		if (!checked.ok) throw new Error("drafted definition is invalid");
		await Service.close(plan);
		let options = roomsHosted(
			authority(context),
			{
				lease() {
					if (!context.lease) throw new Error("test lease was released");
					return context.lease;
				},
			},
			{},
			{ approvers: ["octocat"] },
		);
		return {
			context,
			options,
			input: {
				id: context.channel.id,
				graphVersion: version.number,
				graphRevision: version.revision,
				planRevision: version.planRevision,
				digest: definitionDigest(checked.value),
				idempotencyKey: "hosted:approve:1",
			},
		};
	}

	it("approves a cold document through the adapter and reopens with the record", async () => {
		let review = await reviewable();
		// The bridge's own flow: read the snapshot through the adapter first,
		// then approve exactly what it returned. The first cold open also
		// applies the one-time title normalization, which moves the plan —
		// approving pre-normalization counters would rightly be stale-plan.
		let read = await review.options.coordination!.readSnapshot(caller("octocat"), review.input.id);
		if (read.kind !== "snapshot" || !read.snapshot.graph) {
			throw new Error(`snapshot failed: ${JSON.stringify(read)}`);
		}
		let graph = read.snapshot.graph;
		let outcome = await review.options.coordination!.approve!(caller("octocat"), {
			...review.input,
			graphVersion: graph.version,
			graphRevision: graph.revision,
			planRevision: graph.planRevision,
			digest: graph.digest!,
		});
		if (outcome.kind !== "approved") {
			throw new Error(`hosted approval failed: ${JSON.stringify(outcome)}`);
		}
		expect(outcome.graph).toMatchObject({
			state: "approved",
			approvedBy: "octocat",
			operationKey: "hosted:approve:1",
		});

		// The approval, its stamp and its ledger record survive a reopen.
		let reopened = await Service.open(
			review.context.channel.id,
			review.context.backend,
			review.context.server,
		);
		try {
			let version = reopened.graph!.versions.at(-1)!;
			expect(version.state).toBe("approved");
			expect(version).toMatchObject({ approvedBy: "octocat", operationKey: "hosted:approve:1" });
			expect(reopened.coordinationOps).toHaveLength(1);
			expect(reopened.coordinationOps[0]).toMatchObject({
				kind: "approve",
				principal: "octocat",
			});
		} finally {
			await Service.close(reopened);
		}
	});

	it("refuses callers outside the allowlist", async () => {
		let review = await reviewable();
		let refused = await review.options.coordination!.approve!(
			caller("someone-else"),
			review.input,
		);
		expect(refused).toEqual({ kind: "refused", code: "not-allowed" });
	});
});
