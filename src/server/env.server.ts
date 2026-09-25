import { z } from "zod";
import { mainTargets } from "@/lib/main-targets";

/**
 * The app server's environment (SPEC §5.1), parsed once, lazily, and memoized:
 * importing this module never throws. Slices with their own rules live next to
 * their code (`auth/env.server.ts` for auth and email, `live/env.server.ts` for
 * Redis); this one covers the rest.
 */
const blankToUndefined = (v: unknown) =>
	typeof v === "string" && v.trim() === "" ? undefined : v;
const opt = z.preprocess(blankToUndefined, z.string().optional());
const flag = z.preprocess(
	blankToUndefined,
	z
		.enum(["1", "0", "true", "false"])
		.optional()
		.transform((v) => v === "1" || v === "true"),
);

const url = (fallback: string) =>
	z.preprocess(blankToUndefined, z.url().default(fallback));
const optUrl = z.preprocess(blankToUndefined, z.url().optional());

const Schema = z.object({
	NODE_ENV: z.string().default("development"),
	APP_NAME: z.preprocess(blankToUndefined, z.string().default("Yonder")),
	APP_URL: z.preprocess(
		blankToUndefined,
		z.url().default("http://localhost:3000"),
	),
	DATABASE_URL: opt,
	S3_ENDPOINT: z.preprocess(
		blankToUndefined,
		z.url().default("http://localhost:8080"),
	),
	S3_PUBLIC_ENDPOINT: z.preprocess(blankToUndefined, z.url().optional()),
	S3_REGION: z.preprocess(blankToUndefined, z.string().default("us-east-1")),
	S3_BUCKET: z.preprocess(blankToUndefined, z.string().default("trip-media")),
	S3_ACCESS_KEY_ID: z.preprocess(
		blankToUndefined,
		z.string().default("trip-local"),
	),
	S3_SECRET_ACCESS_KEY: z.preprocess(
		blankToUndefined,
		z.string().default("trip-local-secret"),
	),
	S3_FORCE_PATH_STYLE: z.preprocess(
		blankToUndefined,
		z
			.enum(["1", "0", "true", "false"])
			.default("true")
			.transform((v) => v === "1" || v === "true"),
	),
	/**
	 * ADDENDUM §12: every account's storage quota in GB (1 GB = 1024³ bytes)
	 * unless `user.storage_quota_bytes` overrides it (`set-quota`).
	 */
	STORAGE_QUOTA_DEFAULT_GB: z.preprocess(
		blankToUndefined,
		z.coerce.number().nonnegative().default(5),
	),
	VITE_COLLAB_URL: opt,
	// ---- Maps and routing providers (SPEC §3, .env.example) ----
	GOOGLE_MAPS_API_KEY: opt,
	/** Places API (New); e2e points it at a stub. */
	GOOGLE_PLACES_URL: url("https://places.googleapis.com"),
	/** Routes API; the TI-4 Routes stub overrides it. */
	GOOGLE_ROUTES_URL: url("https://routes.googleapis.com"),
	NAVITIME_RAPIDAPI_KEY: opt,
	NAVITIME_URL: url("https://navitime-route-totalnavi.p.rapidapi.com"),
	OSRM_FOOT_URL: url("https://routing.openstreetmap.de/routed-foot"),
	PHOTON_URL: url("https://photon.komoot.io"),
	/** Overpass API interpreter: OSM `opening_hours` of places (E1, WP-Insights). */
	OVERPASS_URL: url("https://overpass-api.de/api/interpreter"),
	/**
	 * An email or URL the deployer controls, sent in the User-Agent to the
	 * FOSSGIS/Photon/Overpass services (their usage policies). Required in
	 * production: `osmUserAgent()` refuses without it.
	 */
	OSM_CONTACT: opt,
	ODPT_CONSUMER_KEY: opt,
	// ---- Media processing (worker) ----
	/** Empty = `ffmpeg` / `ffprobe` on PATH. */
	FFMPEG_PATH: opt,
	FFPROBE_PATH: opt,
	/**
	 * PDF pages and thumbnails (ADDENDUM §9, WP-Media). Empty = `pdftoppm` on
	 * PATH; `pdfinfo` is looked up next to it (poppler-utils).
	 */
	PDFTOPPM_PATH: opt,
	// ---- EXTENSIONS §11: climate (E3) and FX (E5) ----
	OPEN_METEO_ARCHIVE_URL: url("https://archive-api.open-meteo.com"),
	/** The paid `customer-archive-api` key (only if the free tier doesn't apply). */
	OPEN_METEO_API_KEY: opt,
	CLIMATE_ENABLED: z.preprocess(
		blankToUndefined,
		z
			.enum(["1", "0", "true", "false"])
			.default("true")
			.transform((v) => v === "1" || v === "true"),
	),
	/**
	 * Daily FX rates (ADDENDUM §7.3: a free no-key source covering USD, CAD,
	 * JPY, KRW, VND, TWD, TRY; e.g. the fawazahmed0 currency-api on jsDelivr).
	 * Empty disables conversion (`getCapabilities().fx`).
	 */
	FX_URL: optUrl,
	/**
	 * The currency-api's Cloudflare mirror, used when jsDelivr fails. Per date
	 * the host becomes `<YYYY-MM-DD>.currency-api.pages.dev`.
	 */
	FX_FALLBACK_URL: optUrl,
	/** Optional cross-check source (Frankfurter v2; lacks TWD and VND). */
	FX_CHECK_URL: optUrl,
	ENABLE_TEST_ROUTES: flag,
	AUTOFILL_MAX_PROVIDER_CALLS_PER_TRIP_PER_DAY: z.preprocess(
		blankToUndefined,
		z.coerce.number().int().nonnegative().default(300),
	),
});

export type AppEnv = z.output<typeof Schema> & {
	/** APP_URL's origin. */
	appOrigin: string;
	/** APP_URL is on localhost / 127.0.0.1 (test-only switches are honoured only then). */
	isLocal: boolean;
	isProduction: boolean;
};

let memo: AppEnv | undefined;

export function getEnv(): AppEnv {
	if (memo) return memo;
	const parsed = Schema.parse(process.env);
	const app = new URL(parsed.APP_URL);
	const isProduction = parsed.NODE_ENV === "production";
	if (isProduction && !parsed.OSM_CONTACT)
		console.warn(
			"[env] OSM_CONTACT is not set: Photon and OSRM calls are refused in production (osmUserAgent)",
		);
	memo = {
		...parsed,
		appOrigin: app.origin,
		isLocal: /^(localhost|127\.0\.0\.1|\[::1\])$/.test(app.hostname),
		isProduction,
	};
	return memo;
}

/** Tests only: forget the parsed env so a changed `process.env` is read again. */
export function resetEnv(): void {
	memo = undefined;
}

/** `POST /api/test/fixture` and other test-only switches: on only for localhost URLs. */
export function testRoutesEnabled(env: AppEnv = getEnv()): boolean {
	return env.ENABLE_TEST_ROUTES && env.isLocal && !env.isProduction;
}

/**
 * The first thing every `/api/test/*` handler does: a 404 when test routes
 * are off, a 403 when this server runs on the main stack (database `trip`,
 * bucket `trip-media` or Redis prefix `yonder`: the owner's real trips) even
 * with `ENABLE_TEST_ROUTES=1`, else null (go on). Test data goes to an
 * isolated stack (`pnpm agent:env <n>`); there is no override.
 */
export function testRouteGuard(
	env: AppEnv = getEnv(),
	raw: Record<string, string | undefined> = process.env,
): Response | null {
	if (!testRoutesEnabled(env))
		return new Response("Not found", { status: 404 });
	const main = mainTargets(raw);
	if (main.length)
		return Response.json(
			{
				error: "MAIN_STACK",
				message: `Test routes never write to the main stack: ${main.join("; ")}. Run the app with an isolated env (pnpm agent:env <n>).`,
			},
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	return null;
}

/**
 * The User-Agent for Photon, FOSSGIS OSRM and Overpass (their usage policies
 * want a contact). Throws in production when OSM_CONTACT is unset, so providers fail
 * visibly instead of being blocked upstream.
 */
export function osmUserAgent(env: AppEnv = getEnv()): string {
	if (!env.OSM_CONTACT && env.isProduction)
		throw new Error("OSM_CONTACT is required for Photon/OSRM in production");
	return `${env.APP_NAME}/1.0 (+${env.OSM_CONTACT ?? "dev"})`;
}
