/**
 * Serialized, queue-free access to a live document's plan, for operations
 * that take the plan's own `Service.exclusive` inside.
 *
 * The composition deliberately holds no document lock across the room's plan
 * opening: a cold room opens under its channel's document lock, so an outer
 * lock held here would wait on the very open it is waiting for. Serialization
 * comes from the document transition, and the mutation serializes itself on
 * the plan's queue.
 */

import type { Plan } from "../plan/service";
import type { Room } from "../rooms";

export type LivePlanDeps = {
	/** Serializes with document lifecycle transitions, such as archive. */
	transition<T>(channelId: string, action: () => Promise<T>): Promise<T>;
	/** Whether the document is deleting or archiving, so access refuses. */
	unavailable(channelId: string): boolean;
	/** The room's in-flight close, if one has begun. */
	closing(channelId: string): Promise<unknown> | undefined;
	/** Holds the room open for the access; release when done. */
	hold(channelId: string): { room: Room; release(): void };
	/** Drops the room once its last holder releases it. */
	evict(room: Room): void;
	/** The room's plan, opening it — under the document lock — when cold. */
	plan(room: Room): Promise<Plan>;
};

/** Build plan access from the host's room machinery. */
export function livePlanAccess(deps: LivePlanDeps) {
	return async function access<T>(
		channelId: string,
		action: (plan: Plan) => Promise<T>,
	): Promise<T> {
		return deps.transition(channelId, async () => {
			if (deps.unavailable(channelId)) {
				throw new Error("document is unavailable");
			}
			await deps.closing(channelId);
			let held = deps.hold(channelId);
			try {
				return await action(await deps.plan(held.room));
			} finally {
				held.release();
				deps.evict(held.room);
			}
		});
	};
}
