/**
 * Web Push in the browser: what this device can do, turning it on and off,
 * and keeping an allowed device registered.
 *
 * - Browsers only ask for permission after a click ("Turn on notifications"
 *   on the in-app card or in the settings), never on page load.
 * - iPhone/iPad Safari allows push only for an installed web app (16.4+): a
 *   tab gets `ios-install` (the card explains Add to Home Screen instead).
 * - "This device: off" is remembered here (`OFF_KEY`), so an allowed device
 *   isn't silently re-registered after the person turned it off.
 * - Signing out drops this device's subscription (a shared device must not
 *   keep getting the previous person's notifications).
 *
 * Registration needs the service worker, which only production builds have
 * (`register-sw.ts`); in `vite dev` push reports `unavailable`.
 */
import {
	deletePushSubscription,
	savePushSubscription,
} from "@/functions/push.functions";

export type PushEnv = "supported" | "ios-install" | "unsupported";

const PROMPT_KEY = "yonder.push.prompt";
const OFF_KEY = "yonder.push.off";
const SYNC_KEY = "yonder.push.synced";

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

function isStandalone(): boolean {
	return (
		window.matchMedia?.("(display-mode: standalone)").matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

function isIos(): boolean {
	const ua = navigator.userAgent;
	return (
		/iPad|iPhone|iPod/.test(ua) ||
		(ua.includes("Macintosh") && navigator.maxTouchPoints > 1)
	);
}

export function pushEnv(): PushEnv {
	if (typeof window === "undefined") return "unsupported";
	if (isIos() && !isStandalone()) return "ios-install";
	if (
		!("serviceWorker" in navigator) ||
		!("PushManager" in window) ||
		!("Notification" in window)
	)
		return "unsupported";
	return "supported";
}

export function permission(): NotificationPermission | "unsupported" {
	if (typeof window === "undefined" || !("Notification" in window))
		return "unsupported";
	return Notification.permission;
}

// ---- remembered choices (per device) --------------------------------------------

export function promptSeen(): boolean {
	return !!storage()?.getItem(PROMPT_KEY);
}
export function markPromptSeen(): void {
	storage()?.setItem(PROMPT_KEY, "1");
}
export function deviceOff(): boolean {
	return storage()?.getItem(OFF_KEY) === "1";
}
function setDeviceOff(off: boolean): void {
	if (off) storage()?.setItem(OFF_KEY, "1");
	else storage()?.removeItem(OFF_KEY);
}

// ---- subscription ---------------------------------------------------------------

async function registration(): Promise<ServiceWorkerRegistration | null> {
	if (!("serviceWorker" in navigator)) return null;
	const reg = await navigator.serviceWorker.getRegistration();
	if (!reg) return null;
	if (reg.active) return reg;
	return Promise.race([
		navigator.serviceWorker.ready,
		new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
	]);
}

export function urlBase64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const pad = "=".repeat((4 - (b64.length % 4)) % 4);
	const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
	const k = sub.options?.applicationServerKey;
	if (!k) return true;
	const a = new Uint8Array(k);
	const b = urlBase64ToBytes(publicKey);
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** This device's current subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
	if (pushEnv() !== "supported") return null;
	try {
		const reg = await registration();
		return (await reg?.pushManager.getSubscription()) ?? null;
	} catch {
		return null;
	}
}

async function subscribe(
	reg: ServiceWorkerRegistration,
	publicKey: string,
): Promise<PushSubscription> {
	let sub = await reg.pushManager.getSubscription();
	if (sub && !sameKey(sub, publicKey)) {
		await sub.unsubscribe().catch(() => false);
		sub = null;
	}
	return (
		sub ??
		reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToBytes(publicKey),
		})
	);
}

async function store(sub: PushSubscription): Promise<void> {
	const j = sub.toJSON() as {
		endpoint?: string;
		keys?: { p256dh?: string; auth?: string };
	};
	if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth)
		throw new Error("incomplete subscription");
	await savePushSubscription({
		data: {
			endpoint: j.endpoint,
			keys: { p256dh: j.keys.p256dh, auth: j.keys.auth },
			userAgent: navigator.userAgent.slice(0, 300),
		},
	});
	storage()?.setItem(SYNC_KEY, `${j.endpoint}|${today()}`);
}

const today = () => new Date().toISOString().slice(0, 10);

export type EnableResult = "on" | "denied" | "dismissed" | "unavailable";

/** Asks (from a click), subscribes and registers this device. */
export async function enablePush(publicKey: string): Promise<EnableResult> {
	if (pushEnv() !== "supported") return "unavailable";
	let perm = Notification.permission;
	if (perm === "default") perm = await Notification.requestPermission();
	if (perm === "denied") return "denied";
	if (perm !== "granted") return "dismissed";
	const reg = await registration();
	if (!reg) return "unavailable";
	const sub = await subscribe(reg, publicKey);
	await store(sub);
	setDeviceOff(false);
	markPromptSeen();
	return "on";
}

/** "This device: off": forgets the subscription here and on the server. */
export async function disablePush(): Promise<void> {
	setDeviceOff(true);
	const sub = await currentSubscription();
	if (!sub) return;
	await deletePushSubscription({ data: { endpoint: sub.endpoint } }).catch(
		() => undefined,
	);
	await sub.unsubscribe().catch(() => false);
	storage()?.removeItem(SYNC_KEY);
}

/**
 * Keeps an allowed device registered (a new subscription after the browser
 * rotated it, a new server key, a sign-in on this device). At most once a
 * day per endpoint; never asks for permission; never throws.
 */
export async function syncPushSubscription(publicKey: string): Promise<void> {
	try {
		if (pushEnv() !== "supported" || deviceOff()) return;
		if (Notification.permission !== "granted") return;
		const reg = await registration();
		if (!reg) return;
		const sub = await subscribe(reg, publicKey);
		if (storage()?.getItem(SYNC_KEY) === `${sub.endpoint}|${today()}`) return;
		await store(sub);
	} catch {
		// offline or blocked: the next visit tries again
	}
}

/** Sign-out: this device stops getting this person's notifications. */
export async function dropPushOnSignOut(): Promise<void> {
	const sub = await currentSubscription();
	storage()?.removeItem(SYNC_KEY);
	if (!sub) return;
	await deletePushSubscription({ data: { endpoint: sub.endpoint } }).catch(
		() => undefined,
	);
	await sub.unsubscribe().catch(() => false);
}
