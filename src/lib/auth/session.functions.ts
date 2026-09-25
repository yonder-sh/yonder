import { createServerFn } from "@tanstack/react-start";
import { withSession } from "@/server/authz/middleware";
import { toViewer, type Viewer } from "./viewer";

/**
 * `getSessionFn` (SPEC §13.1): the signed-in viewer, or null. Route guards
 * (`beforeLoad`) and the `['session']` query call it. Guards are UX only;
 * every server function enforces auth itself.
 */
export const getSessionFn = createServerFn({ method: "GET" })
	.middleware([withSession])
	.handler(
		async ({ context }): Promise<Viewer | null> =>
			context.user ? toViewer(context.user) : null,
	);
