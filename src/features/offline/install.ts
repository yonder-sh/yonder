/**
 * "Install app" state (SPEC §12.5 `InstallButton`, QA PWA-01/02): Chromium's
 * `beforeinstallprompt` is captured as early as possible (the root layout's
 * `useHomeLifecycle`) and kept here; iOS Safari has no prompt, so it gets
 * "Add to Home Screen" instructions instead. Standalone (installed) → nothing.
 */
import { useSyncExternalStore } from "react";

type PromptEvent = Event & {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: PromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => {
	for (const l of listeners) l();
};

let watching = false;
/** Starts listening for the install prompt (idempotent, browser only). */
export function watchInstallPrompt(): void {
	if (watching || typeof window === "undefined") return;
	watching = true;
	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault();
		deferred = e as PromptEvent;
		emit();
	});
	window.addEventListener("appinstalled", () => {
		deferred = null;
		emit();
	});
}

export type InstallMode = "prompt" | "ios" | null;

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

function snapshot(): InstallMode {
	if (typeof window === "undefined" || isStandalone()) return null;
	if (deferred) return "prompt";
	return isIos() ? "ios" : null;
}

export function useInstallMode(): InstallMode {
	return useSyncExternalStore(
		(cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		snapshot,
		() => null,
	);
}

/** Shows the browser's install prompt; true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
	const e = deferred;
	if (!e) return false;
	deferred = null;
	emit();
	await e.prompt();
	return (await e.userChoice).outcome === "accepted";
}
