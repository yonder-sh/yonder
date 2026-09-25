import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { authClient } from "@/lib/auth/auth-client";
import {
	AUTH_BRAND,
	JOIN_PATH,
	LOGIN_PATH,
	WELCOME_PATH,
} from "@/lib/auth/constants";
import { saveGrant } from "@/lib/auth/grants";
import { getSessionFn } from "@/lib/auth/session.functions";
import { redeemShareLink } from "@/lib/auth/share.functions";
import { parseShareFragment } from "@/lib/auth/share-link";
import { errorCode } from "@/server/authz/errors";
import { AuthShell } from "./-components/auth-shell";

/**
 * `/join#t=<token>`: the share-link landing page (SECURITY §2, SPEC §11.2).
 *
 * The token arrives in the URL fragment, which never reaches the server,
 * proxies or `Referer`. This page reads it, scrubs it from the address bar,
 * makes sure there is a session (an anonymous guest if nobody is signed in),
 * redeems the token for a grant, remembers `grants[slug] = token` so the guest
 * can come back later, and replaces itself with the trip.
 *
 * A signed-in account without names is sent to /welcome first; the token waits
 * in sessionStorage meanwhile, so it is never put in a query string.
 *
 * There is one link per trip (FB-13) and no per-person join links (FB-14): an
 * old placeholder link (`#c=`) reads as "This link no longer works."
 */
export const Route = createFileRoute("/(auth)/join")({
	ssr: false,
	headers: () => ({
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "private, no-store",
	}),
	head: () => ({
		meta: [
			{ title: `Opening trip · ${AUTH_BRAND.name}` },
			{ name: "referrer", content: "no-referrer" },
		],
	}),
	component: JoinPage,
});

const PENDING_KEY = "yonder:pending-join";

type State =
	| { kind: "working" }
	| { kind: "dead" } // unknown, disabled or revoked link: one message for all (QA LINK-09)
	| { kind: "limited" }
	| { kind: "error" };

function takePendingToken(): string | null {
	try {
		const token = window.sessionStorage.getItem(PENDING_KEY);
		window.sessionStorage.removeItem(PENDING_KEY);
		return token;
	} catch {
		return null;
	}
}

function stashPendingToken(token: string): void {
	try {
		window.sessionStorage.setItem(PENDING_KEY, token);
	} catch {
		// private mode: the user will need the link again after onboarding
	}
}

/** How a failed redemption reads: one message for unknown, off and replaced links (QA LINK-09). */
function failureKind(e: unknown): "dead" | "limited" | "error" {
	const code = errorCode(e);
	return code === "NOT_FOUND"
		? "dead"
		: code === "RATE_LIMITED"
			? "limited"
			: "error";
}

function JoinPage() {
	const router = useRouter();
	const [state, setState] = useState<State>({ kind: "working" });
	const started = useRef(false);

	useEffect(() => {
		/** One redemption at a time (the hash is scrubbed as soon as it starts). */
		let busy = false;

		const redeem = async (token: string): Promise<void> => {
			let createdGuest = false;
			try {
				const viewer = await getSessionFn();
				if (viewer && !viewer.named) {
					stashPendingToken(token);
					await router.navigate({
						href: `${WELCOME_PATH}?${new URLSearchParams({ next: JOIN_PATH })}`,
						replace: true,
					});
					return;
				}
				if (!viewer) {
					const { error } = await authClient.signIn.anonymous();
					if (error) {
						setState({ kind: error.status === 429 ? "limited" : "error" });
						return;
					}
					createdGuest = true;
				}
				const { slug } = await redeemShareLink({ data: { token } });
				saveGrant(slug, token);
				await router.invalidate();
				await router.navigate({
					href: `/t/${encodeURIComponent(slug)}`,
					replace: true,
				});
			} catch (e) {
				// Don't leave an orphan guest behind for a link that didn't work.
				if (createdGuest)
					await authClient.deleteAnonymousUser().catch(() => undefined);
				setState({ kind: failureKind(e) });
			}
		};

		/**
		 * Reads the token from the address bar, scrubs it, and redeems it. On the
		 * first run a missing token falls back to one stashed before onboarding;
		 * later runs (a new link opened in this same tab: only the hash changes,
		 * QA SEC-R2-02) act only on a token in the hash.
		 */
		const run = (initial: boolean) => {
			const fromHash = parseShareFragment(window.location.hash);
			if (!initial && !fromHash) return;
			if (busy) return;
			// Scrub the token from the address bar and history right away.
			if (window.location.hash)
				window.history.replaceState(window.history.state, "", JOIN_PATH);
			const token = fromHash ?? takePendingToken();
			if (!token) {
				setState({ kind: "dead" });
				return;
			}
			busy = true;
			setState({ kind: "working" });
			void redeem(token).finally(() => {
				busy = false;
			});
		};

		if (!started.current) {
			started.current = true; // StrictMode runs effects twice in dev
			run(true);
		}
		// A new link in the same tab changes only the hash: no new page load and
		// no remount. Fragment navigations fire `hashchange`; in-app ones go
		// through the router's history.
		const onChange = () => run(false);
		window.addEventListener("hashchange", onChange);
		const unsubscribe = router.history.subscribe(onChange);
		return () => {
			window.removeEventListener("hashchange", onChange);
			unsubscribe();
		};
	}, [router]);

	if (state.kind === "working") {
		return (
			<AuthShell
				title="Opening the trip…"
				subtitle="Hang on while we check your link."
			>
				<p
					className="flex items-center gap-2 text-sm text-muted-foreground"
					aria-live="polite"
				>
					<Loader2 className="size-4 animate-spin" aria-hidden="true" />{" "}
					Checking link
				</p>
			</AuthShell>
		);
	}

	const copy = {
		dead: {
			title: "This link no longer works.",
			body: "It may have been turned off or replaced. Ask whoever shared it for a new one, or sign in if you're a member of the trip.",
		},
		limited: {
			title: "Too many tries.",
			body: "Wait a minute, then open the link again.",
		},
		error: {
			title: "Something went wrong.",
			body: "Check your connection and open the link again.",
		},
	}[state.kind];

	return (
		<AuthShell title={copy.title} subtitle={copy.body}>
			<Link
				to={LOGIN_PATH}
				className={buttonVariants({ size: "lg", className: "h-11 w-full" })}
				data-testid="join-sign-in"
			>
				Sign in
			</Link>
		</AuthShell>
	);
}
