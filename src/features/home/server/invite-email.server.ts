/**
 * The invite email (SPEC §11.2 flow 5): "Dennis invited you to Asia 2027".
 * The button points to `${APP_URL}/login?next=/t/<slug>`; signing in with the
 * invited address turns the pending row active (`claimInvites`). Never a
 * magic link (QA AUTH-09). Sent AFTER the transaction commits; a failure is
 * logged, never thrown into the caller (the invite row stands either way).
 */
import { BRAND } from "@/lib/brand";
import { maskEmail, sendMail } from "@/server/auth/email.server";
import { getEnv } from "@/server/env.server";

const escapeHtml = (s: string) =>
	s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function inviteEmail(p: {
	appName: string;
	inviter: string;
	tripName: string;
	url: string;
	roleLabel: string;
}): { subject: string; text: string; html: string } {
	const subject = `${p.inviter} invited you to ${p.tripName} on ${p.appName}`;
	const text = [
		`${p.inviter} invited you to plan “${p.tripName}” together on ${p.appName} (${p.roleLabel.toLowerCase()}).`,
		"",
		`Open the trip: ${p.url}`,
		"",
		"Sign in with this email address and the trip will be waiting for you.",
	].join("\n");
	const app = escapeHtml(p.appName);
	const inviter = escapeHtml(p.inviter);
	const trip = escapeHtml(p.tripName);
	const href = escapeHtml(p.url);
	const role = escapeHtml(p.roleLabel.toLowerCase());
	// Hex colours from brand/tokens (email clients don't support oklch()).
	const html = `<!doctype html><html><body style="margin:0;background:#f9fafd;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#181d2f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e0e3eb;border-radius:14px">
<tr><td style="padding:32px 32px 8px;font-size:15px;color:#5c6375">${app}</td></tr>
<tr><td style="padding:0 32px;font-size:22px;font-weight:600;line-height:1.3">${inviter} invited you to ${trip}</td></tr>
<tr><td style="padding:12px 32px 0;font-size:14px;line-height:1.5;color:#5c6375">You can ${role === "can edit" ? "edit the plan" : role === "can suggest" ? "suggest changes" : role === "can rate" ? "rate places" : "view the plan"} with everyone on the trip.</td></tr>
<tr><td style="padding:24px 32px"><a href="${href}" style="display:inline-block;background:#494fa7;color:#f9faff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px">Open the trip</a></td></tr>
<tr><td style="padding:0 32px 32px;font-size:13px;line-height:1.5;color:#5c6375">Sign in with this email address and the trip will be waiting for you.</td></tr>
</table></td></tr></table></body></html>`;
	return { subject, text, html };
}

/** Sends the invite; logs (masked) and swallows failures. */
export async function sendInvite(p: {
	to: string;
	inviter: string;
	tripName: string;
	slug: string;
	roleLabel: string;
}): Promise<void> {
	try {
		const env = getEnv();
		const url = new URL(
			`/login?${new URLSearchParams({ next: `/t/${p.slug}` })}`,
			env.APP_URL,
		).toString();
		const mail = inviteEmail({
			appName: process.env.APP_NAME || BRAND.name,
			inviter: p.inviter,
			tripName: p.tripName,
			url,
			roleLabel: p.roleLabel,
		});
		await sendMail({ to: p.to, ...mail, outboxMeta: { kind: "invite" } });
	} catch (e) {
		console.error(
			`[invite] sending to ${maskEmail(p.to)} failed:`,
			e instanceof Error ? e.message : e,
		);
	}
}
