/**
 * The demo-only scripted draft route: a labeled script revises a document's
 * implementation-graph draft through the real domain path, so the demo never
 * bypasses the revision discipline it exists to show. The revisions it binds
 * are the live plan's, never the caller's; the version it drafts is stamped
 * `draftedBy: "script"`, a disclosure that survives the demo in the sidecar.
 *
 * Gated behind COORDINATION_SCRIPTED_DRAFTS, which requires the coordination
 * family and inherits its approvers allowlist and loopback-bind rule. This
 * route is never offered upstream.
 */

import { implementationGraphs } from "../tasks/plan-graphs";
import { definitionDigest, validate } from "../tasks/graphs";
import { AdmissionDenied } from "../auth/admission";
import { GitHubError } from "../github/client";

import type { Router } from "../http/router";
import type { HostedAuth } from "../auth/routes";
import type { Plan } from "../plan/service";
import type { Operation, Task, Version } from "../tasks/graphs";

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

/** A task the script drafts, exactly as the graph model defines one. */
export type ScriptedTask = Task;

export type ScriptedDraftOptions = {
	/** COORDINATION_APPROVERS, lowercased; the only logins that may draft. */
	approvers: readonly string[];
	/**
	 * Serialized, queue-free access to a live document's plan. The draft takes
	 * the plan's own queue, so access must not hold it.
	 */
	access<T>(channelId: string, action: (plan: Plan) => Promise<T>): Promise<T>;
};

function denied(status: number, code: string): Response {
	return Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
}

function text(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.trim() === value
		&& Array.from(value).length <= maximum;
}

/** The request body: a document and the tasks to draft. Nothing else. */
function scriptedDraft(value: unknown): { id: string; tasks: ScriptedTask[] } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let body = value as Record<string, unknown>;
	if (Object.keys(body).length !== 2) return undefined;
	if (!text(body.id, 128)) return undefined;
	if (!Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > 32) {
		return undefined;
	}
	let tasks: ScriptedTask[] = [];
	for (let item of body.tasks) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		let task = item as Record<string, unknown>;
		if (Object.keys(task).length !== 6) return undefined;
		if (
			!text(task.id, 128) || !text(task.title, 256) || !text(task.context, 4_096)
			|| !text(task.goal, 4_096)
		) return undefined;
		if (
			!Array.isArray(task.acceptance) || task.acceptance.length < 2 || task.acceptance.length > 8
			|| !task.acceptance.every(item => text(item, 512))
		) return undefined;
		if (
			!Array.isArray(task.dependsOn)
			|| !task.dependsOn.every(item => typeof item === "string" && item.trim())
		) return undefined;
		tasks.push({
			id: task.id,
			title: task.title,
			context: task.context,
			goal: task.goal,
			acceptance: task.acceptance,
			dependsOn: task.dependsOn,
		});
	}
	return { id: body.id, tasks };
}

/** The current draft's counters, as the demo's readback shows them. */
function drafted(version: Version) {
	let checked = validate(version.definition);
	return {
		state: version.state,
		version: version.number,
		revision: version.revision,
		planRevision: version.planRevision,
		...(version.draftedBy !== undefined ? { draftedBy: version.draftedBy } : {}),
		...(checked.ok ? { digest: definitionDigest(checked.value) } : {}),
	};
}

/** Register the scripted draft route. */
export function registerScriptedDraftRoutes(
	router: Router,
	auth: HostedAuth,
	options: ScriptedDraftOptions,
): void {
	router.on("POST", "/api/coordination/scripted-draft", async request => {
		let token = request.headers.get("authorization")?.match(BEARER)?.[1];
		if (!token) return denied(401, "unauthorized");
		let login: string;
		try {
			login = (await auth.admission.user(token)).login;
		} catch (err) {
			if (err instanceof AdmissionDenied) return denied(403, "forbidden");
			if (err instanceof GitHubError && err.status === 401) return denied(401, "unauthorized");
			throw err;
		}
		if (!options.approvers.includes(login.toLowerCase())) {
			return denied(403, "not-allowed");
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return denied(400, "invalid");
		}
		const input = scriptedDraft(body);
		if (!input) return denied(400, "invalid");

		let result = await options.access(input.id, async plan => {
			let current = plan.graph?.versions.at(-1);
			// A re-draft replaces the tasks it finds; the initial draft finds none.
			let operations: Operation[] = [];
			for (let task of current?.definition.tasks ?? []) {
				operations.push({ op: "remove", id: task.id });
			}
			for (let task of input.tasks) operations.push({ op: "add", task });
			// The live revisions, never the caller's: the script cannot speak
			// for a plan state it did not read.
			return await implementationGraphs().revise(plan, {
				planRevision: plan.revision,
				graphRevision: current?.revision ?? 0,
				operations,
				draftedBy: "script",
			});
		});
		if (!result.ok) return denied(409, result.reason);
		let version = result.value.versions.at(-1)!;
		return Response.json({ graph: drafted(version) }, {
			headers: { "cache-control": "no-store" },
		});
	});
}
