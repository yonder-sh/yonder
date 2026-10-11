import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { withSession } from "@/server/authz/middleware";
import { PENDING_SIGN_OUT_COOKIE } from "./constants";
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
			// A sign-out this device hasn't got through yet counts as done (A147).
			context.user && !getCookie(PENDING_SIGN_OUT_COOKIE)
				? toViewer(context.user)
				: null,
	);
