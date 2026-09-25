/**
 * `pnpm cleanup:test-data [--keep-owner <email>] [--also <email>…] [--orphans] [--yes --backup <file.dump>]`
 *
 * Removes leftover TEST data from this checkout's database (DATABASE_URL) and
 * bucket (S3_BUCKET): every trip the keeper (default dennis@dennispham.me)
 * doesn't own, and every other account, through the app's own delete paths
 * (`purgeTrip`: the trip's media objects, then `hardDeleteTrip`;
 * `deleteUserAccount`). `--orphans` also deletes S3 objects no row points at
 * (`trips/<id>/` of trips that are gone, `avatars/<userId>/` of deleted
 * accounts). Logic and safety checks: `scripts/lib/cleanup-test-data.ts`.
 *
 * Without `--yes` it is a dry run: it prints the plan, the counts and any
 * blocker. With `--yes` it needs `--backup`, a `pg_dump` of this database
 * taken in the last 24 h, and refuses while any blocker remains (an account
 * that isn't a test account, or one that appears in a kept trip). It prints
 * the counts before and after and proves the kept trips unchanged.
 */
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getDb } from "../src/db/db.server";
import { databaseName } from "../src/db/migrate.server";
import {
	deletePrefix,
	listSubPrefixes,
} from "../src/features/media/server/storage.server";
import { bucket, s3 } from "../src/server/s3.server";
import {
	fingerprintTrips,
	planCleanup,
	runCleanup,
	sweepOrphans,
	totals,
} from "./lib/cleanup-test-data";
import { databaseUrl, run } from "./lib/lifecycle";

const { values } = parseArgs({
	// `pnpm cleanup:test-data -- --yes` passes the `--` through.
	args: process.argv.slice(2).filter((a) => a !== "--"),
	options: {
		"keep-owner": { type: "string", default: "dennis@dennispham.me" },
		yes: { type: "boolean", default: false },
		backup: { type: "string" },
		orphans: { type: "boolean", default: false },
		// Explicitly named extra accounts to delete (owner-approved), e.g. --also someone@real.domain
		also: { type: "string", multiple: true, default: [] },
	},
});

/** Deletes every object under a `trips/<id>/` or `avatars/<userId>/` prefix. */
async function deleteAnyPrefix(prefix: string): Promise<number> {
	if (!/^(trips|avatars)\/[^/]+\/$/.test(prefix))
		throw new Error(`refusing to delete prefix ${prefix}`);
	let deleted = 0;
	let token: string | undefined;
	do {
		const page = await s3().send(
			new ListObjectsV2Command({
				Bucket: bucket(),
				Prefix: prefix,
				ContinuationToken: token,
			}),
		);
		const keys = (page.Contents ?? []).flatMap((o) =>
			o.Key ? [{ Key: o.Key }] : [],
		);
		if (keys.length) {
			await s3().send(
				new DeleteObjectsCommand({
					Bucket: bucket(),
					Delete: { Objects: keys, Quiet: true },
				}),
			);
			deleted += keys.length;
		}
		token = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (token);
	return deleted;
}

run("cleanup:test-data", async () => {
	const db = getDb();
	const dry = !values.yes;
	const tag = `[cleanup]${dry ? " (dry run)" : ""}`;
	console.log(
		`${tag} database ${databaseName(databaseUrl())}, bucket ${bucket()}, keeping ${values["keep-owner"]}'s trips`,
	);
	const plan = await planCleanup(db, {
		keepOwner: values["keep-owner"],
		also: values.also as string[],
	});
	console.log(
		`${tag} keep ${plan.keepTrips.length} trip(s): ${plan.keepTrips.map((t) => t.slug).join(", ")}`,
	);
	console.log(
		`${tag} delete ${plan.deleteTrips.length} trip(s) and ${plan.deleteUsers.length} account(s) (${plan.deleteUsers.filter((u) => u.anonymous).length} anonymous)`,
	);
	const domains = new Map<string, number>();
	for (const u of plan.deleteUsers) {
		const d = u.anonymous ? "(anonymous)" : (u.email.split("@")[1] ?? "?");
		domains.set(d, (domains.get(d) ?? 0) + 1);
	}
	console.log(
		`${tag} accounts by domain: ${[...domains].map(([d, n]) => `${d} ${n}`).join(", ")}`,
	);
	const before = await totals(db);
	console.log(`${tag} before: ${JSON.stringify(before)}`);
	if (plan.blockers.length) {
		for (const b of plan.blockers) console.error(`${tag} BLOCKED: ${b}`);
		process.exitCode = 1;
		return;
	}
	const keepIds = plan.keepTrips.map((t) => t.id);
	const kept = await fingerprintTrips(db, keepIds);
	if (dry) {
		if (values.orphans) {
			const o = await sweepOrphans(db, {
				listSubPrefixes,
				deleteAnyPrefix,
				dryRun: true,
			});
			console.log(
				`${tag} orphans now (before this cleanup): ${JSON.stringify(o)}`,
			);
		}
		console.log(
			`${tag} nothing deleted. Run again with --yes --backup <pg_dump file>.`,
		);
		return;
	}
	const backup = values.backup;
	const st = backup ? statSync(backup, { throwIfNoEntry: false }) : undefined;
	if (!st?.size || Date.now() - st.mtimeMs > 24 * 3600 * 1000)
		throw new Error(
			"--yes needs --backup <file>: a pg_dump of this database from the last 24 h",
		);
	console.log(`${tag} backup ${backup} (${st.size} bytes)`);
	const r = await runCleanup(db, plan, {
		deletePrefix,
		listSubPrefixes,
		log: (l) => console.log(`${tag} ${l}`),
	});
	console.log(`${tag} deleted: ${JSON.stringify(r)}`);
	if (values.orphans) {
		const o = await sweepOrphans(db, {
			listSubPrefixes,
			deleteAnyPrefix,
			log: (l) => console.log(`${tag} ${l}`),
		});
		console.log(`${tag} orphans: ${JSON.stringify(o)}`);
	}
	const after = await totals(db);
	console.log(`${tag} after: ${JSON.stringify(after)}`);
	const now = await fingerprintTrips(db, keepIds);
	const changed = keepIds.filter((id) => now[id] !== kept[id]);
	if (changed.length) {
		for (const id of changed)
			console.error(
				`${tag} KEPT TRIP CHANGED ${id}:\n  ${kept[id]}\n  ${now[id]}`,
			);
		process.exitCode = 1;
	} else
		console.log(
			`${tag} kept trips unchanged: ${plan.keepTrips.map((t) => `${t.slug} [${now[t.id]}]`).join("; ")}`,
		);
});
