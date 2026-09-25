/**
 * Payloads of the `push` queue (BullMQ; `src/server/live/jobs.server.ts`
 * lists every queue). Handlers: `src/server/push/handlers.server.ts`.
 *
 *   push.events  what a committed transaction wants people to hear about
 *                (mentions, suggestions, reviews, membership changes)
 *   push.flush   one person's coalesced window for one trip and group
 *   push.sync    re-plans a trip's reminders and diffs its snapshot
 *                ("changes that affect you", "assigned to you")
 *   push.remind  one planned reminder, checked again when it fires
 *   push.sweep   hourly: syncs every trip that may still plan something
 */
import { z } from "zod";
import { isUuid } from "@/lib/realtime/protocol";
import { TRIP_ROLE_VALUES } from "@/lib/schemas/enums";
import { PUSH_GROUPS } from "./types";

const Uuid = z.string().refine(isUuid, "must be a UUID");
const UserId = z.string().min(1).max(100);

export const PushEvent = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("mention"), memberIds: z.array(Uuid).max(200) }),
	z.object({ kind: z.literal("review"), proposalId: Uuid }),
	z.object({
		kind: z.literal("result"),
		proposalId: Uuid,
		decision: z.enum(["accepted", "rejected"]),
	}),
	z.object({
		kind: z.literal("membership"),
		change: z.enum(["added", "removed", "role"]),
		userId: UserId,
		role: z.enum(TRIP_ROLE_VALUES).optional(),
	}),
]);
export type PushEvent = z.infer<typeof PushEvent>;

export const PushEventsJob = z.object({
	tripId: Uuid,
	/** Who made the change (never notified about it). */
	actor: z.object({ userId: UserId, name: z.string().max(200) }).nullable(),
	/** Epoch ms of the commit. */
	at: z.number().int().nonnegative(),
	events: z.array(PushEvent).min(1).max(100),
});
export type PushEventsJob = z.infer<typeof PushEventsJob>;

export const PushFlushJob = z.object({
	tripId: Uuid,
	userId: UserId,
	group: z.enum(PUSH_GROUPS),
});

export const PushSyncJob = z.object({ tripId: Uuid });

export const PushRemindJob = z.object({
	tripId: Uuid,
	key: z.string().min(1).max(200),
	fireAt: z.number().int(),
});

export const PushSweepJob = z.object({});
