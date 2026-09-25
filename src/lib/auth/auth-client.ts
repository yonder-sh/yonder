import {
	anonymousClient,
	emailOTPClient,
	inferAdditionalFields,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import type { Auth } from "@/server/auth.server";

/**
 * The browser's Better Auth client (SPEC §11.1). Same-origin, so no baseURL:
 * it calls `/api/auth/*` on whatever host served the page. `Auth` is imported
 * as a type only, so no server code reaches the client bundle.
 */
export const authClient = createAuthClient({
	plugins: [emailOTPClient(), anonymousClient(), inferAdditionalFields<Auth>()],
});

export type AuthClient = typeof authClient;
