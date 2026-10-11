import { authClient } from "./auth-client";
import {
	AUTH_BRAND,
	LOGIN_PATH,
	PENDING_SIGN_OUT_COOKIE,
	PENDING_SIGN_OUT_KEY,
} from "./constants";

/**
 * Sign-out for shared devices (SPEC §11.2 flow 8, SECURITY §11). The server
 * also answers `/sign-out` with `Clear-Site-Data: "cache", "storage"`, but
 * browser support varies, so the client wipes explicitly too.
 *
 * Other layers register their own teardown with `onSignOut` (e.g. the query
 * persister's `clearPersisted`, destroying Hocuspocus providers), so this
 * module never needs to import them.
 */
type Cleanup = () => void | Promise<void>;
const cleanups = new Set<Cleanup>();

/** Registers a teardown that runs on sign-out; returns an unregister function. */
export function onSignOut(fn: Cleanup): () => void {
	cleanups.add(fn);
	return () => {
		cleanups.delete(fn);
	};
}

/** Registered cleanups, run in parallel; a failure never blocks the rest. */
async function runCleanups(): Promise<void> {
	await Promise.allSettled([...cleanups].map(async (fn) => fn()));
}

/**
 * Someone else is signed in on this device now (a session ended without a
 * sign-out, QA SEC-R3-03): the same per-layer teardown as a sign-out (the
 * persisted queries, cached pages and offline documents, the share inbox,
 * the collab socket), without signing anyone out.
 */
export function purgePreviousUserData(): Promise<void> {
	return runCleanups();
}

/** localStorage keys that hold private data (UI prefs like theme and layout stay). */
const PRIVATE_LOCAL_KEYS = [
	AUTH_BRAND.storage.grants,
	AUTH_BRAND.storage.grantsGone,
	AUTH_BRAND.storage.savedTrips,
];

/**
 * Deletes this origin's private client data: app localStorage keys, all of
 * sessionStorage, every IndexedDB database (query persister, offline docs) and
 * every Cache Storage entry except the static precache (the app shell and
 * hashed assets hold no user data). Safe to call during SSR (no-op).
 */
export async function wipeClientData(): Promise<void> {
	if (typeof window === "undefined") return;
	try {
		for (const key of PRIVATE_LOCAL_KEYS) window.localStorage.removeItem(key);
		window.sessionStorage.clear();
	} catch {
		// storage disabled
	}
	const tasks: Promise<unknown>[] = [];
	if ("caches" in window) {
		tasks.push(
			caches
				.keys()
				.then((names) =>
					Promise.all(
						names
							.filter((n) => !/precache/i.test(n))
							.map((n) => caches.delete(n)),
					),
				),
		);
	}
	if ("indexedDB" in window) {
		tasks.push(
			(async () => {
				const names =
					typeof indexedDB.databases === "function"
						? (await indexedDB.databases())
								.map((d) => d.name)
								.filter((n): n is string => !!n)
						: ["keyval-store"]; // idb-keyval's default DB (the query persister)
				await Promise.all(
					names.map(
						(name) =>
							new Promise<void>((resolve) => {
								const req = indexedDB.deleteDatabase(name);
								req.onsuccess = req.onerror = req.onblocked = () => resolve();
							}),
					),
				);
			})(),
		);
	}
	await Promise.allSettled(tasks);
}

/** `authClient.signOut()`: true when the server confirmed it. */
async function serverSignOut(): Promise<boolean> {
	try {
		const res = await authClient.signOut();
		return !res?.error;
	} catch {
		return false;
	}
}

const COOKIE_AGE_S = 60 * 60 * 24 * 400;

function markPendingSignOut(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(PENDING_SIGN_OUT_KEY, "1");
	} catch {
		// storage disabled: the cookie still carries it
	}
	const secure = window.location.protocol === "https:" ? "; Secure" : "";
	// biome-ignore lint/suspicious/noDocumentCookie: a plain flag the server reads
	document.cookie = `${PENDING_SIGN_OUT_COOKIE}=1; Path=/; Max-Age=${COOKIE_AGE_S}; SameSite=Lax${secure}`;
}

function clearPendingSignOut(): void {
	try {
		window.localStorage.removeItem(PENDING_SIGN_OUT_KEY);
	} catch {
		// storage disabled
	}
	// biome-ignore lint/suspicious/noDocumentCookie: a plain flag the server reads
	document.cookie = `${PENDING_SIGN_OUT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/** Whether a sign-out on this device still waits for the server. */
export function pendingSignOut(): boolean {
	if (typeof window === "undefined") return false;
	try {
		if (window.localStorage.getItem(PENDING_SIGN_OUT_KEY)) return true;
	} catch {
		// storage disabled: the cookie decides
	}
	return document.cookie
		.split(/;\s*/)
		.some((c) => c.startsWith(`${PENDING_SIGN_OUT_COOKIE}=1`));
}

let settling: Promise<boolean> | null = null;

/**
 * Retries a pending sign-out (A147); the flag clears only when the server
 * confirms. True while it is still pending: treat the viewer as signed out.
 */
export function settlePendingSignOut(): Promise<boolean> {
	if (!pendingSignOut()) return Promise.resolve(false);
	settling ??= serverSignOut()
		.then((ok) => {
			if (ok) clearPendingSignOut();
			return !ok;
		})
		.finally(() => {
			settling = null;
		});
	return settling;
}

export interface SignOutOptions {
	/** The app's QueryClient: cleared so no trip data survives in memory. */
	queryClient?: { clear(): void };
	/** Where to land afterwards (default /login). */
	redirectTo?: string;
	/**
	 * Full page load to `redirectTo` (default true): drops every in-memory store,
	 * socket and closure along with the old session.
	 */
	reload?: boolean;
	/** Used when `reload` is false, e.g. `(to) => router.navigate({ to })`. */
	navigate?: (to: string) => void | Promise<void>;
}

/**
 * Signs out and wipes local data. The local wipe happens even when the
 * network call fails (offline), because the device may be shared.
 */
export async function signOut(opts: SignOutOptions = {}): Promise<void> {
	const {
		queryClient,
		redirectTo = LOGIN_PATH,
		reload = true,
		navigate,
	} = opts;
	await runCleanups();
	// Not confirmed (offline, or an error answer): the HttpOnly cookie still
	// works, so the next start signs out before showing anyone's data (A147).
	if (!(await serverSignOut())) markPendingSignOut();
	queryClient?.clear();
	await wipeClientData();
	if (reload || !navigate) {
		if (typeof window !== "undefined") window.location.assign(redirectTo);
		return;
	}
	await navigate(redirectTo);
}
