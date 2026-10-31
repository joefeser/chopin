import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";

import * as Questions from "../questions/service";
import { hosted as roomsHosted } from "./hosted";
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

describe("hosted coordination answering", () => {
	/** A persisted document with one open card, and the hosted MCP options over it. */
	async function bridge() {
		let context = await room();
		let plan = await seededPlan(context);
		let optionId = ulid();
		let id = await Questions.insertConversationCard(plan, context.server, context.channel.id, {
			threadId: ulid(),
			header: "Format",
			question: "Which format should the report use?",
			options: [{ id: optionId, label: "Markdown" }, { id: ulid(), label: "JSON" }],
		});
		let entry = plan.questions.open.get(id);
		if (!entry) throw new Error("card was not open");
		// Close the seeding instance so the hosted adapter opens the document
		// from storage alone; two live plan instances would conflict on commit.
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
			id,
			optionId,
			revision: entry.revision,
			input: {
				id: context.channel.id,
				questionId: id,
				revision: entry.revision,
				optionIds: [optionId],
				idempotencyKey: "hosted:answer:1",
			},
		};
	}

	it("answers a cold document without deadlocking on the plan queue", async () => {
		let state = await bridge();
		let answered = await state.options.coordination!.answer!(caller("octocat"), state.input);
		if (answered.kind !== "answered") {
			throw new Error(`hosted answer failed: ${JSON.stringify(answered)}`);
		}
		expect(answered.settled.by).toBe("octocat");
		expect(answered.settled.choices).toEqual([state.optionId]);
	});

	it("keeps the ledger openable: the answer survives a close and reopen", async () => {
		let state = await bridge();
		let answered = await state.options.coordination!.answer!(caller("octocat"), state.input);
		if (answered.kind !== "answered") throw new Error("hosted answer failed");

		// The stored sidecar, with its coordination record, must reopen cleanly.
		let reopened = await Service.open(
			state.context.channel.id,
			state.context.backend,
			state.context.server,
		);
		try {
			expect(reopened.records.get(state.id)?.status).toBe("answered");
			expect(reopened.coordinationOps).toHaveLength(1);
			expect(reopened.coordinationOps[0]).toMatchObject({
				idempotencyKey: "hosted:answer:1",
				kind: "answer",
				result: { questionId: state.id, choices: [state.optionId], settledBy: "octocat" },
			});
		} finally {
			await Service.close(reopened);
		}
	});

	it("replays an identical retry and refuses callers outside the allowlist", async () => {
		let state = await bridge();
		let first = await state.options.coordination!.answer!(caller("octocat"), state.input);
		if (first.kind !== "answered") throw new Error("hosted answer failed");

		let retry = await state.options.coordination!.answer!(caller("octocat"), state.input);
		expect(retry).toEqual({ kind: "replayed", settled: first.settled });

		let outsider = await state.options.coordination!.answer!(
			caller("someone-else"),
			{ ...state.input, idempotencyKey: "hosted:answer:2" },
		);
		expect(outsider).toEqual({ kind: "refused", code: "not-allowed" });
	});
});
