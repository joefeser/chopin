import { describe, expect, it } from "bun:test";

import { registerScriptedDraftRoutes } from "./scripted-drafts";
import { AdmissionDenied } from "../auth/admission";
import { GitHubError } from "../github/client";
import { Router } from "../http/router";
import { hosted as room } from "../plan/conversation-persistence.test-fixtures";
import { seededPlan } from "../plan/projection-submit.test-fixtures";

import type { HostedAuth } from "../auth/routes";
import type { Plan } from "../plan/service";

function tasks() {
	return [
		{
			id: "draft",
			title: "Draft the report",
			context: "The report is the document this graph implements.",
			goal: "Write the report the decision settled on.",
			acceptance: ["The report exists.", "It names the chosen format."],
			dependsOn: [],
		},
		{
			id: "review",
			title: "Review the report",
			context: "A second reader checks the draft.",
			goal: "The report survives review.",
			acceptance: ["A reviewer read it.", "Their notes are addressed."],
			dependsOn: ["draft"],
		},
	];
}

/** A router over one live plan; the allowlist admits exactly `approvers`. */
async function routed(approvers: readonly string[] = ["octocat"]) {
	let context = await room();
	let plan = await seededPlan(context);
	let router = new Router();
	let authority = {
		admission: {
			async user(token: string) {
				if (token === "good") return { id: "U_octocat", login: "octocat" };
				if (token === "denied") throw new AdmissionDenied();
				throw new GitHubError("bad credentials", 401);
			},
		},
	} as unknown as HostedAuth;
	registerScriptedDraftRoutes(router, authority, {
		approvers,
		access: async <T>(_channelId: string, action: (plan: Plan) => Promise<T>): Promise<T> =>
			await action(plan),
	});
	return {
		plan,
		async send(token: string | undefined, body: unknown) {
			let headers: Record<string, string> = { "content-type": "application/json" };
			if (token !== undefined) headers.authorization = `Bearer ${token}`;
			let response = await router.handle(
				new Request("http://chopin.test/api/coordination/scripted-draft", {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				}),
			);
			if (!response) throw new Error("the scripted draft route did not handle the request");
			return response;
		},
	};
}

describe("the scripted draft route", () => {
	it("refuses unauthenticated or unadmitted callers, and non-approvers", async () => {
		let demo = await routed();
		let body = { id: "document", tasks: tasks() };

		expect((await demo.send(undefined, body)).status).toBe(401);
		expect((await demo.send("bad", body)).status).toBe(401);
		let denied = await demo.send("denied", body);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({ code: "forbidden" });

		let stranger = await routed(["someone-else"]);
		let refused = await stranger.send("good", body);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ code: "not-allowed" });
	});

	it("refuses bodies that are not a document plus tasks, including revision fields", async () => {
		let demo = await routed();
		for (
			let body of [
				{ id: "document", tasks: tasks(), revision: 4 },
				{ id: "document", tasks: tasks(), planRevision: 4 },
				{ id: "document", tasks: [] },
				{ id: "document", tasks: [{ ...tasks()[0]!, acceptance: ["only one"] }] },
				{ id: "document" },
				{ tasks: tasks() },
				{ id: " document", tasks: tasks() },
			]
		) {
			let response = await demo.send("good", body);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ code: "invalid" });
		}
	});

	it("drafts an initial graph at the live revision, stamped as scripted", async () => {
		let demo = await routed();
		let before = demo.plan.revision;
		let response = await demo.send("good", { id: demo.plan.id, tasks: tasks() });
		expect(response.status).toBe(200);
		let graph = (await response.json() as { graph: Record<string, unknown> }).graph;
		expect(graph).toMatchObject({
			state: "draft",
			version: 1,
			revision: 1,
			planRevision: before,
			draftedBy: "script",
		});
		expect(typeof graph.digest).toBe("string");

		// The stamp is durable on the plan's graph, not just the reply.
		let version = demo.plan.graph?.versions.at(-1)!;
		expect(version.draftedBy).toBe("script");
		expect(version.planRevision).toBe(before);
		expect(version.definition.tasks.map(task => task.id)).toEqual(["draft", "review"]);
	});

	it("re-drafts in place, replacing the tasks and keeping the stamp", async () => {
		let demo = await routed();
		await demo.send("good", { id: demo.plan.id, tasks: tasks() });
		let second = [{ ...tasks()[0]!, title: "Draft the settled report" }];
		let response = await demo.send("good", { id: demo.plan.id, tasks: second });
		expect(response.status).toBe(200);
		let graph = (await response.json() as { graph: Record<string, unknown> }).graph;
		expect(graph).toMatchObject({
			state: "draft",
			version: 1,
			revision: 2,
			draftedBy: "script",
		});
		let version = demo.plan.graph?.versions.at(-1)!;
		expect(version.definition.tasks).toHaveLength(1);
		expect(version.definition.tasks[0]).toMatchObject({ title: "Draft the settled report" });
	});

	it("reports a locked graph as a typed conflict", async () => {
		let demo = await routed();
		let locked = await demo.send("good", { id: demo.plan.id, tasks: tasks() });
		expect(locked.status).toBe(200);
		// A locked version refuses revision; reach it through the model's own state.
		let version = demo.plan.graph!.versions.at(-1)!;
		demo.plan.graph!.versions[demo.plan.graph!.versions.length - 1] = {
			...version,
			state: "locked",
		};
		let response = await demo.send("good", { id: demo.plan.id, tasks: tasks() });
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ code: "locked" });
	});
});
