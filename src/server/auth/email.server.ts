import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { authEnv } from "./env.server";

/**
 * Outgoing mail for auth (SPEC §5.1 "Email"): Resend when RESEND_API_KEY is
 * set, else SMTP (nodemailer) when SMTP_HOST is set, else the console. With
 * EMAIL_OUTBOX_DIR (localhost only) every message is ALSO written as JSON so
 * tests can read codes from a production build (QA TI-2).
 *
 * `sendMail` is transport-generic; the F owner's `sendMail` helper (SPEC §13.1)
 * can re-export it rather than duplicate the transports.
 */
export interface Mail {
	to: string;
	subject: string;
	text: string;
	html: string;
	/** Extra fields for the JSON outbox only (never sent). */
	outboxMeta?: Record<string, unknown>;
}

export type MailTransport = "resend" | "smtp" | "console";

export function mailTransport(): MailTransport {
	const env = authEnv();
	if (env.RESEND_API_KEY) return "resend";
	if (env.SMTP_HOST) return "smtp";
	return "console";
}

/** "someone@company.io" → "s***@company.io" (SECURITY §12: no raw emails in logs). */
export function maskEmail(email: string): string {
	const at = email.lastIndexOf("@");
	if (at <= 0) return "***";
	return `${email.slice(0, 1)}***${email.slice(at)}`;
}

const SEND_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${what} timed out after ${ms} ms`)),
			ms,
		);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function writeOutbox(dir: string, mail: Mail): Promise<void> {
	const abs = resolve(dir);
	await mkdir(abs, { recursive: true });
	const file = join(abs, `${Date.now()}-${randomUUID()}.json`);
	const { outboxMeta, ...message } = mail;
	await writeFile(
		file,
		JSON.stringify(
			{ ...message, ...outboxMeta, sentAt: new Date().toISOString() },
			null,
			2,
		),
	);
}

type NodemailerTransporter = {
	sendMail(m: Record<string, unknown>): Promise<unknown>;
};
let smtp: NodemailerTransporter | undefined;

async function smtpTransport(): Promise<NodemailerTransporter> {
	if (!smtp) {
		const env = authEnv();
		const nodemailer = await import("nodemailer");
		smtp = nodemailer.createTransport({
			host: env.SMTP_HOST,
			port: env.SMTP_PORT,
			secure: env.SMTP_SECURE,
			auth: env.SMTP_USER
				? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" }
				: undefined,
			connectionTimeout: SEND_TIMEOUT_MS,
			greetingTimeout: SEND_TIMEOUT_MS,
			socketTimeout: SEND_TIMEOUT_MS,
		});
	}
	return smtp;
}

/**
 * Sends one message through the configured transport. Rejects when delivery
 * fails (the caller decides whether that reaches the user).
 */
export async function sendMail(mail: Mail): Promise<void> {
	const env = authEnv();
	if (env.EMAIL_OUTBOX_DIR) await writeOutbox(env.EMAIL_OUTBOX_DIR, mail);

	const transport = mailTransport();
	const { to, subject, text, html } = mail;
	if (transport === "resend") {
		const { Resend } = await import("resend");
		const { error } = await withTimeout(
			new Resend(env.RESEND_API_KEY).emails.send({
				from: env.EMAIL_FROM,
				to,
				subject,
				text,
				html,
			}),
			SEND_TIMEOUT_MS,
			"Resend",
		);
		if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
		return;
	}
	if (transport === "smtp") {
		const t = await smtpTransport();
		await withTimeout(
			t.sendMail({ from: env.EMAIL_FROM, to, subject, text, html }),
			SEND_TIMEOUT_MS + 2000,
			"SMTP",
		);
		return;
	}
	// Console: fine in dev; in production without a transport the message would
	// silently vanish, so that is a failure unless the outbox captured it.
	if (env.isProduction && !env.EMAIL_OUTBOX_DIR)
		throw new Error(
			"no email transport configured (set RESEND_API_KEY or SMTP_HOST)",
		);
	console.log(`[mail] to=${maskEmail(to)} subject=${JSON.stringify(subject)}`);
}

const escapeHtml = (s: string) =>
	s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The sign-in code email: a code, never a link that signs you in (QA AUTH-09). */
export function otpEmail(p: {
	appName: string;
	otp: string;
	expiresInMin: number;
}): { subject: string; text: string; html: string } {
	const app = escapeHtml(p.appName);
	const code = escapeHtml(p.otp);
	const subject = `${p.otp} is your ${p.appName} sign-in code`;
	const text = [
		`Your ${p.appName} sign-in code is ${p.otp}`,
		"",
		`It expires in ${p.expiresInMin} minutes. If you didn't ask for it, you can ignore this email.`,
	].join("\n");
	// Hex colours from brand/tokens (email clients don't support oklch()).
	const html = `<!doctype html><html><body style="margin:0;background:#f9fafd;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#181d2f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="420" cellpadding="0" cellspacing="0" style="max-width:420px;background:#ffffff;border:1px solid #e0e3eb;border-radius:14px">
<tr><td style="padding:32px 32px 8px;font-size:15px;color:#5c6375">${app}</td></tr>
<tr><td style="padding:0 32px;font-size:22px;font-weight:600">Your sign-in code</td></tr>
<tr><td style="padding:20px 32px"><div style="font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;font-size:34px;letter-spacing:10px;font-weight:600;color:#494fa7">${code}</div></td></tr>
<tr><td style="padding:0 32px 32px;font-size:14px;line-height:1.5;color:#5c6375">It expires in ${p.expiresInMin} minutes. If you didn't ask for it, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
	return { subject, text, html };
}
