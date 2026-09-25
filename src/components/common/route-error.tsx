import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TESTID } from "@/lib/testids";
import { EmptyState } from "./empty-state";
import { YonderMark } from "./yonder-mark";

/**
 * The branded error page (QA ERR-04): any route without its own error view
 * (the router's `defaultErrorComponent`), e.g. `/dashboard` or `/login`
 * while the database is down. One line and a retry that re-runs the route's guards and
 * loaders, so the page recovers once the service is back. Never shows the
 * error's message or stack (SECURITY: no internals in the page).
 */
export function RouteError({ reset }: Pick<ErrorComponentProps, "reset">) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const retry = async () => {
		setBusy(true);
		try {
			reset();
			await router.invalidate();
		} finally {
			setBusy(false);
		}
	};
	return (
		<main
			data-testid={TESTID.routeError}
			className="flex min-h-svh flex-col items-center justify-center gap-6 p-8"
		>
			<YonderMark className="size-8 text-primary" />
			<EmptyState
				line="Something went wrong, try again."
				action={
					<Button
						variant="outline"
						data-testid={TESTID.routeErrorRetry}
						disabled={busy}
						onClick={() => void retry()}
					>
						Try again
					</Button>
				}
			/>
		</main>
	);
}
