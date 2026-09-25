import { cn } from "cn";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTheme } from "@/components/theme-provider";

/**
 * Cloudflare Turnstile for the steps that send a sign-in code (the login
 * email step, "Resend code", the re-auth prompt). Off (no widget, no token)
 * without a site key: the key comes from `getPublicConfig` at runtime.
 *
 *   const turnstile = useTurnstile(siteKey);
 *   <Turnstile controller={turnstile} />
 *   const token = await turnstile.token();   // null: off, or no token in time
 *   … send with header `x-captcha-response: token` …
 *   turnstile.reset();                       // tokens are single-use
 *
 * The widget follows the app's light/dark theme, refreshes an expired token
 * by itself and retries failures; `reset()` asks for a fresh token.
 */

const SCRIPT_SRC =
	"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
	render(el: HTMLElement, options: Record<string, unknown>): string | undefined;
	reset(widgetId?: string): void;
	remove(widgetId?: string): void;
};

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	loading ??= new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SCRIPT_SRC;
		script.async = true;
		script.onload = () =>
			window.turnstile
				? resolve(window.turnstile)
				: reject(new Error("Turnstile didn't load"));
		script.onerror = () => {
			loading = null;
			script.remove();
			reject(new Error("Turnstile didn't load"));
		};
		document.head.appendChild(script);
	});
	return loading;
}

type Box = {
	token: string | null;
	waiters: Set<(token: string) => void>;
	reset: (() => void) | null;
};

export type TurnstileController = {
	enabled: boolean;
	siteKey: string | null;
	/** The current token, waiting up to `ms` for the check; null when off or none came. */
	token(ms?: number): Promise<string | null>;
	/** Drop the used token and ask for a fresh one. */
	reset(): void;
	/** @internal wired by `<Turnstile>`. */
	box: Box;
};

export function useTurnstile(
	siteKey: string | null | undefined,
): TurnstileController {
	const box = useRef<Box>({
		token: null,
		waiters: new Set(),
		reset: null,
	}).current;
	const key = siteKey || null;
	const token = useCallback(
		(ms = 30_000): Promise<string | null> => {
			if (!key) return Promise.resolve(null);
			if (box.token) return Promise.resolve(box.token);
			return new Promise((resolve) => {
				const done = (t: string | null) => {
					clearTimeout(timer);
					box.waiters.delete(done);
					resolve(t);
				};
				const timer = setTimeout(() => done(null), ms);
				box.waiters.add(done);
			});
		},
		[box, key],
	);
	const reset = useCallback(() => {
		box.token = null;
		box.reset?.();
	}, [box]);
	return useMemo(
		() => ({ enabled: !!key, siteKey: key, token, reset, box }),
		[key, token, reset, box],
	);
}

/**
 * The widget. `appearance="interaction-only"` stays invisible unless a
 * visitor must click (the code step, where it only backs "Resend code").
 */
export function Turnstile(props: {
	controller: TurnstileController;
	appearance?: "always" | "interaction-only";
	className?: string;
}) {
	const { siteKey } = props.controller;
	return siteKey ? <TurnstileWidget {...props} siteKey={siteKey} /> : null;
}

function TurnstileWidget({
	controller,
	siteKey,
	appearance = "always",
	className,
}: {
	controller: TurnstileController;
	siteKey: string;
	appearance?: "always" | "interaction-only";
	className?: string;
}) {
	const el = useRef<HTMLDivElement>(null);
	const { resolvedTheme } = useTheme();
	const { box } = controller;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `resolvedTheme` re-renders the widget in the new theme (it is read from the DOM class).
	useEffect(() => {
		let cancelled = false;
		let api: TurnstileApi | null = null;
		let id: string | undefined;
		const setToken = (t: string | null) => {
			box.token = t;
			if (t) for (const w of [...box.waiters]) w(t);
		};
		// After this commit's effects (the theme provider sets `.dark` in its
		// own), so the widget renders once, in the theme on screen.
		const start = setTimeout(() => {
			loadTurnstile()
				.then((t) => {
					if (cancelled || !el.current) return;
					api = t;
					const dark = document.documentElement.classList.contains("dark");
					id = t.render(el.current, {
						sitekey: siteKey,
						theme: dark ? "dark" : "light",
						appearance,
						size: "flexible",
						action: "sign-in",
						"refresh-expired": "auto",
						"refresh-timeout": "auto",
						retry: "auto",
						callback: (token: string) => setToken(token),
						"expired-callback": () => setToken(null),
						"error-callback": () => {
							setToken(null);
						},
						"timeout-callback": () => {
							setToken(null);
							if (id) t.reset(id);
						},
					});
					box.reset = () => {
						if (id) t.reset(id);
					};
				})
				.catch(() => {
					// No widget: `token()` times out and the form says so.
				});
		}, 0);
		return () => {
			cancelled = true;
			clearTimeout(start);
			box.token = null;
			box.reset = null;
			if (api && id) api.remove(id);
		};
	}, [siteKey, box, appearance, resolvedTheme]);

	return (
		<div
			ref={el}
			className={cn(
				"w-full",
				appearance === "always" && "min-h-[65px]",
				className,
			)}
			data-testid="turnstile"
		/>
	);
}
