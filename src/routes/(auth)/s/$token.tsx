import { createFileRoute, redirect } from "@tanstack/react-router";
import { JOIN_PATH } from "@/lib/auth/constants";

/**
 * `/s/$token`: the share URL shape in SPEC §12.1. Kept only so such links keep
 * working; it immediately continues at `/join#t=<token>`, replacing this
 * history entry. New links should use `shareLinkUrl()` (fragment form), which
 * never sends the token to the server.
 */
export const Route = createFileRoute("/(auth)/s/$token")({
	ssr: false,
	headers: () => ({
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "private, no-store",
	}),
	beforeLoad: ({ params }) => {
		throw redirect({
			href: `${JOIN_PATH}#t=${encodeURIComponent(params.token)}`,
			replace: true,
		});
	},
});
