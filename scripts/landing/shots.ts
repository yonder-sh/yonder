/**
 * `pnpm landing:shots`: the landing page's product screenshots, end to end.
 *
 *   1. an isolated env (`pnpm agent:env <n>`: its own database, bucket, Redis
 *      prefix and ports; never the main stack), migrated and seeded with the
 *      demo seed, then the showcase trip (`showcase.ts`, invented data);
 *   2. `vite dev` for it (with the test switches), until it answers;
 *   3. Playwright captures every screen (`e2e/landing-shots.mjs`, desktop and
 *      phone, light and dark);
 *   4. sharp writes each as AVIF and WebP, full and half width, into
 *      `public/landing/` (sizes from `src/features/landing/shots.ts`), each
 *      under 200 kB;
 *   5. the dev server stops (the env's database and bucket stay; they're
 *      disposable and the next run replaces the trip).
 *
 *   pnpm landing:shots                  # env 87
 *   pnpm landing:shots --env 88 --only places,plan
 *   pnpm landing:shots --reuse          # an env already sourced and running
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import sharp from "sharp";
import { SHOTS, type Shot, shotSrc } from "../../src/features/landing/shots";
import { mainTargets } from "../../src/lib/main-targets";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "public/landing");
const MAX_BYTES = 200 * 1024;

const { values } = parseArgs({
	options: {
		env: { type: "string", default: "87" },
		reuse: { type: "boolean", default: false },
		only: { type: "string", default: "" },
		"skip-capture": { type: "boolean", default: false },
	},
});

function sh(
	cmd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd = ROOT,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd, env, stdio: "inherit" });
		p.on("exit", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
		);
	});
}

async function waitFor(url: string, ms: number): Promise<void> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		try {
			const r = await fetch(url);
			if (r.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`${url} did not answer within ${ms / 1000} s`);
}

/** Encodes one raw PNG into the shot's files, lowering quality until each fits. */
async function encode(raw: string, shot: Shot, theme: "light" | "dark") {
	const widths: [number, boolean][] = [[shot.width, false]];
	if (shot.half) widths.push([shot.width / 2, true]);
	for (const [w, half] of widths) {
		const h = Math.round((shot.height * w) / shot.width);
		const base = sharp(raw).resize(w, h, { fit: "cover", position: "top" });
		for (const ext of ["avif", "webp"] as const) {
			const file = path.join(ROOT, "public", shotSrc(shot, theme, ext, half));
			let q = ext === "avif" ? 58 : 82;
			let buf: Buffer;
			for (;;) {
				buf =
					ext === "avif"
						? await base.clone().avif({ quality: q, effort: 5 }).toBuffer()
						: await base.clone().webp({ quality: q, effort: 5 }).toBuffer();
				if (buf.length <= MAX_BYTES || q <= 40) break;
				q -= 6;
			}
			await sharp(buf).toFile(file);
			console.log(
				`[landing:shots] ${path.relative(ROOT, file)} ${(buf.length / 1024).toFixed(0)} kB (q${q})`,
			);
		}
	}
}

async function main() {
	let env: NodeJS.ProcessEnv = { ...process.env };
	let dev: ChildProcess | null = null;
	const only = values.only.split(",").filter(Boolean);
	const raw = path.join(ROOT, ".data/landing-shots-raw");
	// A fresh capture never re-encodes an older run's screens.
	if (!values["skip-capture"]) rmSync(raw, { recursive: true, force: true });
	mkdirSync(raw, { recursive: true });
	mkdirSync(OUT, { recursive: true });
	try {
		if (!values["skip-capture"]) {
			if (!values.reuse) {
				const n = values.env;
				const file = `.data/landing-shots-${n}.env`;
				await sh("pnpm", ["agent:env", n, "--out", file, "--force"], env);
				env = {
					...process.env,
					...(parseEnv(
						readFileSync(path.join(ROOT, file), "utf8"),
					) as NodeJS.ProcessEnv),
				};
			}
			const main = mainTargets(env, { app: true });
			if (main.length)
				throw new Error(`refusing the main stack: ${main.join("; ")}`);
			const appUrl = env.APP_URL as string;
			if (!values.reuse) {
				await sh("pnpm", ["db:create"], env);
				dev = spawn("pnpm", ["dev"], {
					cwd: ROOT,
					env: { ...env, ENABLE_TEST_ROUTES: "1", VITE_E2E: "1" },
					stdio: ["ignore", "inherit", "inherit"],
					detached: true,
				});
			}
			await waitFor(`${appUrl}/api/health`, 180_000);
			await sh("pnpm", ["exec", "tsx", "scripts/landing/showcase.ts"], env);
			// A failed screen doesn't stop the others: what was captured is encoded.
			await sh(
				"bash",
				[
					"e2e/pw.sh",
					"node",
					"landing-shots.mjs",
					"--base",
					appUrl,
					"--out",
					raw,
					...(only.length ? ["--only", only.join(",")] : []),
				],
				env,
			).catch((e: unknown) => {
				console.error("[landing:shots]", e instanceof Error ? e.message : e);
				process.exitCode = 1;
			});
		}
		for (const shot of Object.values(SHOTS)) {
			if (only.length && !only.includes(shot.name)) continue;
			for (const theme of shot.themes) {
				const file = path.join(raw, `${shot.name}-${theme}.png`);
				if (!existsSync(file) || statSync(file).size === 0) {
					console.warn(`[landing:shots] missing ${file}`);
					process.exitCode = 1;
					continue;
				}
				await encode(file, shot, theme);
			}
		}
	} finally {
		if (dev?.pid) {
			// The whole group: pnpm, concurrently, vite, the collab server and worker.
			try {
				process.kill(-dev.pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
	}
}

main().catch((e) => {
	console.error("[landing:shots]", e instanceof Error ? e.message : e);
	process.exitCode = 1;
});
