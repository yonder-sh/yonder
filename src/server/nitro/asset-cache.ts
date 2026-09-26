/**
 * Nitro's `/assets/**` rule gives every response there a year-long
 * `immutable`, a 404 included, so Cloudflare would keep the miss: a new chunk
 * asked of an old pod mid-rollout would stay broken for everyone. A miss is
 * `no-store` instead (the rule's headers win over any handler's, so this
 * runs on the finished response).
 */
import { definePlugin } from "nitro";

export function isAssetMiss(pathname: string, status: number): boolean {
	return status >= 400 && pathname.startsWith("/assets/");
}

export default definePlugin((nitroApp) => {
	nitroApp.hooks.hook("response", (res, event) => {
		if (isAssetMiss(new URL(event.req.url).pathname, res.status))
			res.headers.set("Cache-Control", "no-store");
	});
});
