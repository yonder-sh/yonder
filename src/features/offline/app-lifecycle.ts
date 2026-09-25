/**
 * WP-Home's app-wide mount point (SPEC §16; CONTRACTS §4.9). The root layout
 * (`src/routes/__root.tsx`, F) calls `useHomeLifecycle()` once on every page
 * — /login, /welcome, /join and the workspace included — so the service
 * worker registers everywhere but the public landing page (`/`), the install
 * prompt is captured early, and WP-Home's sign-out purge always runs.
 * WP-Home owns this file.
 */
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { onSignOut } from "@/lib/auth/sign-out";
import { watchInstallPrompt } from "./install";
import { registerServiceWorker } from "./register-sw";
import { clearSavedTrips } from "./saved-trips";

/** IndexedDB `yonder-share` (E8 entries): gone at sign-out (QA SHR-06). */
async function clearShareInbox(): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase("yonder-share");
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

/** The service worker's runtime caches that hold user data (the precache holds none). */
const USER_CACHES = ["pages", "media-thumbs", "media-docs", "api"];
/** WP-Media's per-trip offline documents (`yonder-docs-<tripId>`). */
const USER_CACHE_PREFIXES = ["yonder-docs-"];

/**
 * Sign-out purge owned by WP-Home (SPEC §11.2 flow 8, SECURITY §11, QA
 * PWA-08): the SW caches of trip pages and media thumbs, the saved-trips
 * index and the E8 share inbox. The root layer already clears the persisted
 * query cache and the collab socket (and `wipeClientData` sweeps the rest).
 */
export async function homeSignOutCleanup(): Promise<void> {
	clearSavedTrips();
	const tasks: Promise<unknown>[] = [clearShareInbox()];
	if (typeof caches !== "undefined") {
		tasks.push(...USER_CACHES.map((c) => caches.delete(c).catch(() => false)));
		tasks.push(
			caches
				.keys()
				.then((keys) =>
					Promise.all(
						keys
							.filter((k) => USER_CACHE_PREFIXES.some((p) => k.startsWith(p)))
							.map((k) => caches.delete(k)),
					),
				)
				.catch(() => []),
		);
	}
	await Promise.allSettled(tasks);
}

export function useHomeLifecycle(): void {
	// The public landing page (`/`) skips the worker: its precache is the
	// app, which a first-time visitor may never open. Leaving it (sign-in,
	// the dashboard) registers it then.
	const onLanding = useRouterState({
		select: (s) => s.location.pathname === "/",
	});
	useEffect(() => {
		watchInstallPrompt();
		return onSignOut(() => homeSignOutCleanup());
	}, []);
	useEffect(() => {
		if (!onLanding) void registerServiceWorker();
	}, [onLanding]);
}
