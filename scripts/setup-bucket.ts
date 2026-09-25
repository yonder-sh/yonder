/**
 * Configures the media bucket (S3_BUCKET) for production. Idempotent: every
 * step PUTs the whole desired configuration, so re-running changes nothing.
 * Bundled by `pnpm build:scripts` to `.output/scripts/setup-bucket.mjs`
 * (the app image runs it as a one-shot next to migrate.mjs).
 *
 *   N pnpm s3:setup                                (dev: the checkout's bucket)
 *   node .output/scripts/setup-bucket.mjs           (prod, from the app image)
 *
 * 1. The bucket exists (created when missing; an ObjectBucketClaim usually
 *    made it). Unreachable storage or bad credentials: exit 1.
 * 2. Versioning ON: overwritten and deleted objects stay as noncurrent
 *    versions (the owner's media "backup", in-cluster Ceph).
 * 3. Lifecycle: abort incomplete multipart uploads after 1 day; expire
 *    noncurrent versions after 14 days (and the delete markers left behind).
 * 4. CORS: APP_URL's origin (plus BETTER_AUTH_URL and TRUSTED_ORIGINS) may
 *    PUT, GET and HEAD with any request header; ETag is exposed (multipart
 *    parts), with Content-Length/Range for reads.
 *
 * Storage that lacks one of these (s3proxy has none of 2-4; some Ceph RGW
 * versions reject parts of a lifecycle rule) logs a warning and goes on, so
 * the script still exits 0; each step reads the setting back and prints it.
 */
import {
	GetBucketCorsCommand,
	GetBucketLifecycleConfigurationCommand,
	GetBucketVersioningCommand,
	type LifecycleRule,
	PutBucketCorsCommand,
	PutBucketLifecycleConfigurationCommand,
	PutBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { getEnv } from "../src/server/env.server";
import { bucket, ensureBucket, resetS3, s3 } from "../src/server/s3.server";

const log = (line: string) => console.log(`[setup-bucket] ${line}`);
const warnings: string[] = [];

function why(e: unknown): string {
	const err = e as {
		name?: string;
		message?: string;
		$metadata?: { httpStatusCode?: number };
	};
	const status = err.$metadata?.httpStatusCode;
	return `${err.name ?? "Error"}${status ? ` (${status})` : ""}: ${err.message ?? String(e)}`;
}

/** Runs one optional step; a failure is a warning, never fatal. */
async function step(name: string, run: () => Promise<void>): Promise<boolean> {
	try {
		await run();
		return true;
	} catch (e) {
		const line = `${name}: not applied, ${why(e)}`;
		warnings.push(line);
		console.warn(`[setup-bucket] WARN ${line}`);
		return false;
	}
}

/** The browser origins that upload to and read from the bucket. */
export function corsOrigins(env: Record<string, string | undefined>): string[] {
	const out = new Set<string>();
	for (const raw of [
		env.APP_URL,
		env.BETTER_AUTH_URL,
		...(env.TRUSTED_ORIGINS ?? "").split(","),
	]) {
		const v = raw?.trim();
		if (!v) continue;
		try {
			out.add(new URL(v).origin);
		} catch {
			warnings.push(`CORS: ignored the origin ${JSON.stringify(v)}`);
		}
	}
	return [...out];
}

export const LIFECYCLE_RULES: LifecycleRule[] = [
	{
		ID: "abort-incomplete-multipart",
		Status: "Enabled",
		Filter: { Prefix: "" },
		AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
	},
	{
		ID: "expire-noncurrent-versions",
		Status: "Enabled",
		Filter: { Prefix: "" },
		NoncurrentVersionExpiration: { NoncurrentDays: 14 },
		Expiration: { ExpiredObjectDeleteMarker: true },
	},
];

async function main(): Promise<void> {
	const env = getEnv();
	const name = bucket();
	log(`bucket ${name} at ${env.S3_ENDPOINT}`);

	// 1. The bucket (fatal: nothing else can work without it).
	const created = await ensureBucket(name);
	log(created ? "created the bucket" : "the bucket exists");

	// 2. Versioning.
	await step("versioning", async () => {
		await s3().send(
			new PutBucketVersioningCommand({
				Bucket: name,
				VersioningConfiguration: { Status: "Enabled" },
			}),
		);
	});
	await step("versioning (read back)", async () => {
		const v = await s3().send(new GetBucketVersioningCommand({ Bucket: name }));
		log(`versioning: ${v.Status ?? "off"}`);
		if (v.Status !== "Enabled")
			throw new Error(`status is ${v.Status ?? "off"}`);
	});

	// 3. Lifecycle: the whole set, else without the delete-marker cleanup
	// (older RGW rejects Expiration next to NoncurrentVersionExpiration).
	const put = (Rules: LifecycleRule[]) =>
		s3().send(
			new PutBucketLifecycleConfigurationCommand({
				Bucket: name,
				LifecycleConfiguration: { Rules },
			}),
		);
	const full = await step("lifecycle", async () => {
		await put(LIFECYCLE_RULES);
	});
	if (!full)
		await step("lifecycle (without delete-marker cleanup)", async () => {
			await put(LIFECYCLE_RULES.map(({ Expiration: _drop, ...rule }) => rule));
		});
	await step("lifecycle (read back)", async () => {
		const l = await s3().send(
			new GetBucketLifecycleConfigurationCommand({ Bucket: name }),
		);
		for (const r of l.Rules ?? [])
			log(
				`lifecycle: ${r.ID} ${r.Status}${
					r.AbortIncompleteMultipartUpload
						? `, abort multipart after ${r.AbortIncompleteMultipartUpload.DaysAfterInitiation} d`
						: ""
				}${
					r.NoncurrentVersionExpiration
						? `, noncurrent versions after ${r.NoncurrentVersionExpiration.NoncurrentDays} d`
						: ""
				}${r.Expiration?.ExpiredObjectDeleteMarker ? ", expired delete markers" : ""}`,
			);
	});

	// 4. CORS for browser uploads (presigned PUTs, multipart parts) and reads.
	const origins = corsOrigins(process.env);
	await step("CORS", async () => {
		if (!origins.length) throw new Error("no APP_URL to allow");
		await s3().send(
			new PutBucketCorsCommand({
				Bucket: name,
				CORSConfiguration: {
					CORSRules: [
						{
							ID: "yonder-browser",
							AllowedOrigins: origins,
							AllowedMethods: ["PUT", "GET", "HEAD"],
							AllowedHeaders: ["*"],
							ExposeHeaders: [
								"ETag",
								"Content-Length",
								"Content-Range",
								"Accept-Ranges",
							],
							MaxAgeSeconds: 3600,
						},
					],
				},
			}),
		);
	});
	await step("CORS (read back)", async () => {
		const c = await s3().send(new GetBucketCorsCommand({ Bucket: name }));
		for (const r of c.CORSRules ?? [])
			log(
				`CORS: ${r.AllowedMethods?.join(",")} from ${r.AllowedOrigins?.join(" ")}, exposes ${r.ExposeHeaders?.join(",")}`,
			);
	});

	log(
		warnings.length
			? `done with ${warnings.length} warning(s): the storage lacks the settings above`
			: "done",
	);
}

if (!process.env.VITEST)
	main()
		.catch((e: unknown) => {
			console.error("[setup-bucket]", why(e));
			process.exitCode = 1;
		})
		.finally(() => resetS3());
