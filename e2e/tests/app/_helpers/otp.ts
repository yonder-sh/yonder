/**
 * Reading a sign-in code the way a tester would (SPEC §18.5, QA TI-2):
 *   1. `DEV_FIXED_OTP` when the server runs with one;
 *   2. the newest JSON in `EMAIL_OUTBOX_DIR` for that address;
 *   3. the dev server's log line `[auth] OTP type=sign-in email=<email> code=NNNNNN`
 *      (`E2E_APP_LOG` = the file the dev server's output goes to).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./env";

/** The current size of the app log, so a later read only sees newer lines. */
export function logOffset(): number {
	const file = process.env.E2E_APP_LOG;
	return file && existsSync(file) ? statSync(file).size : 0;
}

function fromLog(email: string, since = 0): string | null {
	const file = process.env.E2E_APP_LOG;
	if (!file || !existsSync(file)) return null;
	const text = readFileSync(file).subarray(since).toString("utf8");
	const re = new RegExp(`\\[auth\\] OTP type=sign-in email=${email.replace(/[.+]/g, "\\$&")} code=(\\d{6})`, "g");
	let last: string | null = null;
	for (const m of text.matchAll(re)) last = m[1] ?? null;
	return last;
}

function fromOutbox(email: string): string | null {
	const dir = process.env.EMAIL_OUTBOX_DIR;
	if (!dir) return null;
	const abs = path.resolve(REPO_ROOT, dir);
	if (!existsSync(abs)) return null;
	const files = readdirSync(abs)
		.filter((f) => f.endsWith(".json"))
		.map((f) => path.join(abs, f))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	for (const f of files) {
		const mail = JSON.parse(readFileSync(f, "utf8")) as { to?: string; subject?: string };
		if (mail.to === email) return /\b(\d{6})\b/.exec(mail.subject ?? "")?.[1] ?? null;
	}
	return null;
}

/** The newest code sent to `email`, polling up to `ms` (the send is async). */
export async function readOtp(
	email: string,
	opts: { ms?: number; since?: number } = {},
): Promise<string> {
	const deadline = Date.now() + (opts.ms ?? 10_000);
	for (;;) {
		const code =
			fromLog(email, opts.since) ??
			fromOutbox(email) ??
			(process.env.DEV_FIXED_OTP || null);
		if (code) return code;
		if (Date.now() > deadline) throw new Error(`no sign-in code found for ${email}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** Only the log line (the onboarding spec proves the real path). */
export async function readOtpFromLog(email: string, since = 0, ms = 10_000): Promise<string> {
	const deadline = Date.now() + ms;
	for (;;) {
		const code = fromLog(email, since);
		if (code) return code;
		if (Date.now() > deadline)
			throw new Error(`no "[auth] OTP … email=${email}" line in E2E_APP_LOG=${process.env.E2E_APP_LOG ?? "(unset)"}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}
