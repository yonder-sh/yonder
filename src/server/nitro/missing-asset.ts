/**
 * A missing `/assets/*` file (another build's chunk): a plain 404, without
 * rendering the app's not-found page. Files that exist never get here (Nitro
 * serves them first); `asset-cache.ts` keeps the miss out of every cache.
 */
import { defineHandler } from "nitro/h3";

export default defineHandler((event) => {
	event.res.status = 404;
	return "Not found";
});
