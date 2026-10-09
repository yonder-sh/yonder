import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { redeemInviteLink } from "@/features/home/sharing.functions";
import { pageTitle } from "@/lib/brand";

/**
 * `/join/<token>`: an invite link (owner, 2026-10-09). The `_authed` layout
 * signs people in first (and back here); then they join the trip at the
 * link's role and land in it. A deleted or unknown link says so.
 */
export const Route = createFileRoute("/_authed/join/$token")({
	ssr: false,
	head: () => ({ meta: [{ title: pageTitle("Join a trip") }] }),
	component: JoinRoute,
});

function JoinRoute() {
	const { token } = Route.useParams();
	const navigate = useNavigate();
	const join = useMutation({
		mutationFn: () => redeemInviteLink({ data: { token } }),
		onSuccess: ({ slug }) =>
			navigate({ to: "/t/$trip", params: { trip: slug }, replace: true }),
	});
	// Once per link (a dev double effect would count the link opened twice).
	const sent = useRef<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per link
	useEffect(() => {
		if (sent.current === token) return;
		sent.current = token;
		join.mutate();
	}, [token]);
	return (
		<main className="grid min-h-svh place-items-center p-6">
			{join.isError ? (
				<div
					data-testid="join-invalid"
					className="flex max-w-sm flex-col items-start gap-3"
				>
					<h1 className="font-display text-2xl font-semibold">
						This invite link doesn't work any more
					</h1>
					<p className="text-body text-muted-foreground">
						It may have been deleted. Ask whoever sent it for a new one.
					</p>
					<Button asChild>
						<Link to="/dashboard">Your trips</Link>
					</Button>
				</div>
			) : (
				<span className="flex items-center gap-2 text-muted-foreground">
					<Spinner /> Joining the trip…
				</span>
			)}
		</main>
	);
}
