import { expect, test } from "bun:test";
import { openPlan } from "../testing/plan";
import * as Service from "./service";
import { staged } from "./staged-publication.test-fixtures";

import type { CoordinationOpRecord } from "../tasks/coordination-ops";

let record: CoordinationOpRecord = {
	idempotencyKey: "bridge:answer:staged",
	kind: "answer",
	fingerprint: "f".repeat(64),
	principal: "chopin-bridge-bot",
	payloadDigest: "d".repeat(64),
	result: { questionId: "01M696N0", choice: "01M696N0PQQNQS9HJYXMJ5PJHR", settledBy: "joefeser" },
	committedAt: "2026-10-31T18:00:00.000Z",
};

test("staged coordination operations adopt into the live plan and survive later persists and reopen", async () => {
	let context = await openPlan("# Before\n");
	let { plan, server, backend } = context;
	let { candidate, mutation } = await staged(plan, "# After\n");
	try {
		candidate.coordinationOps = [record];
		await Service.exclusive(
			plan,
			() => Service.publishStaged(plan, server, plan.id, candidate, mutation),
		);
		expect(plan.coordinationOps).toEqual([record]);

		let second = await staged(plan, "# After\n\n## More\n");
		// The fixture appends a fixed effect on every call; a second copy would
		// duplicate it and rightly fail restore. Keep effects unchanged here.
		second.candidate.conversationPlanEffects = plan.conversationPlanEffects;
		await Service.exclusive(
			plan,
			() => Service.publishStaged(plan, server, plan.id, second.candidate, second.mutation),
		);
		expect(plan.coordinationOps).toEqual([record]);

		await Service.close(plan);
		let reopened = await Service.open(plan.id, backend, server);
		expect(reopened.coordinationOps).toEqual([record]);
		await Service.close(reopened);
	} finally {
		candidate.document.doc.destroy();
	}
});
