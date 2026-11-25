import { createHash } from "node:crypto";
import { offlineRequestText } from "./offline";
import { ULID } from "@chopin/dialect";
import { insertConversationCard } from "../questions/service";
import type { Router } from "../http/router";
import type { HostedAuth } from "./routes";
import type { ScriptedDraftOptions } from "../coordination/scripted-drafts";
import type { Server } from "bun";
import type { SocketData } from "../wire";

function deny(code: string, status: number): Response {
	return Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
}

/** Local workers can request a decision; this route cannot answer or approve it. */
export function registerOfflineDecisions(
	router: Router,
	auth: HostedAuth,
	access: ScriptedDraftOptions["access"],
	server: () => Server<SocketData>,
): void {
	if (!auth.config.offline) throw new Error("local decision requests require offline identity");
	router.on("POST", "/api/offline/decisions", async request => {
		if (request.headers.get("origin") !== auth.config.origin) return deny("origin", 403);
		let token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
		if (!token) return deny("unauthorized", 401);
		let user;
		try {
			user = await auth.admission.user(token);
		} catch {
			return deny("unauthorized", 401);
		}
		let text = await offlineRequestText(request, 8192);
		if (text === undefined) return deny("too-large", 413);
		let input: {
			documentId: string;
			requestId: string;
			question: string;
			options: { id: string; label: string }[];
		};
		try {
			input = JSON.parse(text);
			if (
				!input || typeof input.documentId !== "string" || typeof input.requestId !== "string"
				|| !ULID.test(input.requestId)
				|| typeof input.question !== "string" || !input.question.trim()
				|| input.question !== input.question.trim() || input.question.length > 100
				|| /[\r\n\u2028\u2029]/.test(input.question) || !Array.isArray(input.options)
				|| input.options.length < 2 || input.options.length > 4
				|| input.options.some(o =>
					!o || typeof o.id !== "string" || !ULID.test(o.id) || typeof o.label !== "string"
					|| !o.label.trim() || o.label !== o.label.trim() || /[\r\n\u2028\u2029]/.test(o.label)
					|| o.label.length > 40
				)
				|| new Set(input.options.map(o => o.id)).size !== input.options.length
			) return deny("invalid", 400);
		} catch {
			return deny("invalid", 400);
		}
		let channel = await auth.storage.channels.get(input.documentId);
		if (!channel || channel.archivedAt) return deny("unavailable", 404);
		try {
			let repository = await auth.github.repository(
				token,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			if (!repository.permissions.push) return deny("forbidden", 403);
		} catch {
			return deny("forbidden", 403);
		}
		let threadId = createHash("sha256").update(JSON.stringify([user.id, input.requestId])).digest(
			"hex",
		);
		try {
			return await access(channel.id, async plan => {
				let existing = [...plan.records.values()].find(record => record.threadId === threadId);
				let id = existing?.id ?? await insertConversationCard(plan, server(), channel.id, {
					threadId,
					header: "Local review",
					question: input.question,
					options: input.options.map(o => ({ id: o.id, label: o.label })),
				});
				let record = plan.records.get(id)!;
				let question = record.definition.questions[0]!;
				if (
					question.question !== input.question
					|| JSON.stringify(question.options.map(o => ({ id: o.id, label: o.label })))
						!== JSON.stringify(input.options.map(o => ({ id: o.id, label: o.label })))
				) {
					return deny("idempotency-conflict", 409);
				}
				return Response.json({
					id,
					state: record.status,
					revision: plan.questions.open.get(id)?.revision,
				}, { headers: { "cache-control": "no-store" } });
			});
		} catch {
			return deny("request-unavailable", 409);
		}
	});
}
