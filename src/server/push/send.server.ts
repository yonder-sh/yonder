/**
 * Delivering one payload to one person's devices (`web-push`, VAPID). A push
 * service answering 404/410 means the subscription is gone: its row is
 * deleted. Other failures are logged and skipped (the next notification
 * tries again); nothing here throws for a device.
 */
import { createHash } from "node:crypto";
import webpush from "web-push";
import { db } from "@/db/db.server";
import type { PushGroup, PushPayload } from "@/lib/push/types";
import { type PushConfig, pushConfig } from "./env.server";
import {
	listSubscriptions,
	markSubscriptionUsed,
	removeGoneSubscription,
	type StoredSubscription,
} from "./store.server";

type Exec = Parameters<typeof listSubscriptions>[0];

/** Sends one encrypted message; resolves with the push service's status. */
export type PushSender = (
	sub: StoredSubscription,
	body: string,
	opts: { ttl: number; urgency: "normal" | "high"; topic: string },
	config: PushConfig,
) => Promise<{ statusCode: number }>;

export const webPushSender: PushSender = async (sub, body, opts, config) => {
	const res = await webpush.sendNotification(
		{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
		body,
		{
			vapidDetails: config,
			TTL: opts.ttl,
			urgency: opts.urgency,
			topic: opts.topic,
			contentEncoding: "aes128gcm",
			timeout: 15_000,
		},
	);
	return { statusCode: res.statusCode };
};

let activeSender: PushSender = webPushSender;

/** Tests only: route every send through `sender` (null = the real web-push). */
export function setPushSenderForTests(sender: PushSender | null): void {
	activeSender = sender ?? webPushSender;
}

/** How long a push service may hold the message for an offline device. */
export function ttlFor(group: PushGroup): number {
	switch (group) {
		case "booking":
		case "due":
			return 3600;
		case "today":
			return 4 * 3600;
		default:
			return 24 * 3600;
	}
}

/** RFC 8030 topic: ≤ 32 base64url chars; a newer message replaces an undelivered one. */
export function topicOf(tag: string): string {
	return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

function statusOf(e: unknown): number | null {
	const code = (e as { statusCode?: unknown } | null)?.statusCode;
	return typeof code === "number" ? code : null;
}

export type DeliverResult = { sent: number; removed: number; failed: number };

/** Sends `payload` to each subscription; drops the ones that are gone. */
export async function deliver(
	exec: Exec,
	subs: readonly StoredSubscription[],
	payload: PushPayload,
	group: PushGroup,
	opts: { config?: PushConfig | null; send?: PushSender } = {},
): Promise<DeliverResult> {
	const config = opts.config === undefined ? pushConfig() : opts.config;
	const out: DeliverResult = { sent: 0, removed: 0, failed: 0 };
	if (!config || !subs.length) return out;
	const send = opts.send ?? activeSender;
	const body = JSON.stringify(payload);
	const meta = {
		ttl: ttlFor(group),
		urgency:
			group === "booking" || group === "due"
				? ("high" as const)
				: ("normal" as const),
		topic: topicOf(payload.tag),
	};
	for (const sub of subs) {
		let status: number | null;
		try {
			status = (await send(sub, body, meta, config)).statusCode;
		} catch (e) {
			status = statusOf(e);
			if (status !== 404 && status !== 410) {
				out.failed++;
				console.warn(
					`[push] send to ${new URL(sub.endpoint).host} failed${status ? ` (${status})` : ""}: ${e instanceof Error ? e.message.slice(0, 200) : e}`,
				);
				continue;
			}
		}
		if (status === 404 || status === 410) {
			await removeGoneSubscription(exec, sub.id);
			out.removed++;
			continue;
		}
		out.sent++;
		await markSubscriptionUsed(exec, sub.id).catch(() => {});
	}
	return out;
}

/** Every device of one person. */
export async function sendToUser(
	userId: string,
	payload: PushPayload,
	group: PushGroup,
	opts: { exec?: Exec; send?: PushSender } = {},
): Promise<DeliverResult> {
	const exec = opts.exec ?? db;
	const subs = await listSubscriptions(exec, [userId]);
	return deliver(exec, subs, payload, group, { send: opts.send });
}
