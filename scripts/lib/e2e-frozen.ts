/**
 * `pnpm e2e:fast --frozen …`: the run happens in a git worktree beside the
 * repo (`../trip-planner-e2e`), checked out at HEAD, so the working tree can
 * keep changing while the envs (vite dev servers) serve the commit under
 * test. The worktree shares `.env`, `.data/e2e-fast` (the template's stamp
 * and the storageStates) and the local-only seed photos with the repo, and
 * installs from the pnpm store (offline) only when the lockfiles changed.
 * Uncommitted work is not tested.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./e2e-fast";

export const FROZEN_DIR = path.resolve(REPO_ROOT, "../trip-planner-e2e");

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function lockHash(dir: string): string {
	const h = createHash("sha256");
	for (const f of [
		"package.json",
		"pnpm-lock.yaml",
		"e2e/package.json",
		"e2e/pnpm-lock.yaml",
	]) {
		const p = path.join(dir, f);
		h.update(existsSync(p) ? readFileSync(p) : "");
	}
	return h.digest("hex");
}

function install(cwd: string, extra: string[] = []): void {
	const r = spawnSync(
		"pnpm",
		["install", "--frozen-lockfile", "--offline", ...extra],
		{ cwd, stdio: "inherit" },
	);
	if (r.status !== 0) throw new Error(`pnpm install failed in ${cwd}`);
}

/** Puts the worktree at HEAD, ready to run; returns the commit. */
export function prepareFrozen(): string {
	const sha = git(REPO_ROOT, "rev-parse", "HEAD");
	if (git(REPO_ROOT, "status", "--porcelain", "--untracked-files=no"))
		console.log(
			"[e2e:fast] --frozen: uncommitted changes are not in this run (it tests HEAD)",
		);
	if (!existsSync(path.join(FROZEN_DIR, ".git")))
		git(REPO_ROOT, "worktree", "add", "--detach", FROZEN_DIR, sha);
	else git(FROZEN_DIR, "checkout", "--detach", "--force", sha);
	copyFileSync(path.join(REPO_ROOT, ".env"), path.join(FROZEN_DIR, ".env"));
	mkdirSync(path.join(FROZEN_DIR, ".data"), { recursive: true });
	const link = path.join(FROZEN_DIR, ".data/e2e-fast");
	const isLink = (() => {
		try {
			return lstatSync(link).isSymbolicLink();
		} catch {
			return false;
		}
	})();
	if (!isLink) {
		rmSync(link, { recursive: true, force: true });
		symlinkSync(path.join(REPO_ROOT, ".data/e2e-fast"), link);
	}
	linkLocalOnlyMedia();
	const stamp = path.join(FROZEN_DIR, ".data/install.stamp");
	const hash = lockHash(FROZEN_DIR);
	const was = existsSync(stamp) ? readFileSync(stamp, "utf8") : "";
	if (was !== hash) {
		install(FROZEN_DIR);
		install(path.join(FROZEN_DIR, "e2e"), ["--ignore-workspace"]);
		writeFileSync(stamp, hash);
	}
	return sha;
}

/** The seed photos kept out of git (no open licence, see seed/media/.gitignore): linked in, as the importer spec uploads them. */
function linkLocalOnlyMedia(): void {
	const files = git(
		REPO_ROOT,
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"seed/media",
	)
		.split("\n")
		.filter(Boolean);
	for (const f of files) {
		const to = path.join(FROZEN_DIR, f);
		if (!existsSync(to)) symlinkSync(path.join(REPO_ROOT, f), to);
	}
}

/** Runs e2e-fast from the worktree with the same arguments (minus --frozen). */
export function runFrozen(argv: string[]): number {
	const sha = prepareFrozen();
	console.log(
		`[e2e:fast] --frozen: testing ${sha.slice(0, 7)} from ${FROZEN_DIR} (results in its e2e/test-results)`,
	);
	// A --baseline file named from the repo stays the repo's.
	const args = argv
		.filter((a) => a !== "--frozen")
		.map((a, i, all) => (all[i - 1] === "--baseline" ? path.resolve(a) : a));
	const r = spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/e2e-fast.ts", ...args],
		{ cwd: FROZEN_DIR, stdio: "inherit", env: process.env },
	);
	return r.status ?? 1;
}
