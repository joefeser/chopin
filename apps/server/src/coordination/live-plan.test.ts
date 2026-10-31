import { describe, expect, it } from "bun:test";

import { livePlanAccess } from "./live-plan";

import type { LivePlanDeps } from "./live-plan";
import type { Plan } from "../plan/service";
import type { Room } from "../rooms";

/**
 * Rooms whose plans open lazily under a per-channel document lock, as the
 * host's do. Transitions are a separate chain from document locks, exactly
 * as the host keeps them: conflating the two would manufacture a deadlock
 * the real wiring does not have.
 */
function channels() {
	type Channel = { room: Room; plan?: Plan; opening?: Promise<Plan> };
	let open = new Map<string, Channel>();
	let transitions = new Map<string, Promise<unknown>>();
	let locks = new Map<string, Promise<unknown>>();
	let order: string[] = [];
	function chained(map: Map<string, Promise<unknown>>) {
		return function chain<T>(id: string, action: () => Promise<T>): Promise<T> {
			let previous = map.get(id) ?? Promise.resolve();
			let operation = previous.then(action, action);
			map.set(id, operation.then(() => {}, () => {}));
			return operation;
		};
	}
	let transition = chained(transitions);
	let lock = chained(locks);
	let deps: LivePlanDeps = {
		transition,
		unavailable: id => id === "deleting",
		closing: () => undefined,
		hold: id => {
			let channel = open.get(id) ?? { room: { id } as Room };
			open.set(id, channel);
			return { room: channel.room, release: () => {} };
		},
		evict: () => {},
		async plan(room) {
			let channel = open.get(room.id)!;
			// A cold room opens under its channel's document lock, exactly as
			// the host does: the composition under test must not hold that
			// lock across this call.
			channel.opening ??= lock(room.id, async () => {
				order.push(`open ${room.id}`);
				channel.plan = { id: room.id } as Plan;
				return channel.plan;
			});
			return await channel.opening;
		},
	};
	return { deps, order, open };
}

describe("live plan access", () => {
	it("hands an action a cold room's plan without waiting on its own lock", async () => {
		let host = channels();
		let access = livePlanAccess(host.deps);
		let seen = await access("document", async plan => plan.id);
		expect(seen).toBe("document");
		expect(host.order).toEqual(["open document"]);
		expect(host.open.get("document")!.plan).toBeDefined();
	});

	it("serializes accesses to one document and opens it once", async () => {
		let host = channels();
		let access = livePlanAccess(host.deps);
		let ran: number[] = [];
		await Promise.all([
			access("document", async () => {
				ran.push(1);
			}),
			access("document", async () => {
				ran.push(2);
			}),
		]);
		expect(ran).toEqual([1, 2]);
		expect(host.order).toEqual(["open document"]);
	});

	it("refuses a document that is going away", async () => {
		let host = channels();
		let access = livePlanAccess(host.deps);
		await expect(access("deleting", async () => "never")).rejects.toThrow(
			"document is unavailable",
		);
		expect(host.open.has("deleting")).toBe(false);
	});
});
