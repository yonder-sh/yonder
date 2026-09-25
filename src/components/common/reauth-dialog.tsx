import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Turnstile, useTurnstile } from "@/components/common/turnstile";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/auth-client";
import { authErrorMessage } from "@/lib/auth/auth-errors";
import { LOGIN_PATH } from "@/lib/auth/constants";
import { publicConfigQuery } from "@/lib/auth/public-config.functions";
import { useReauth } from "@/lib/auth/reauth";
import type { Viewer } from "@/lib/auth/viewer";
import { sessionKey } from "@/lib/query/keys";
import { reconnectCollabClient } from "@/lib/realtime/collab-client";

/**
 * QA ERR-07: "You're signed out" mid-edit opens this prompt over the page.
 * Accounts get the email code step right here (their address from the last
 * known session); once the same account is back, the saves that failed run
 * again and the page stays where it was. A link guest has no email: the page
 * reloads, which re-enters through their remembered link.
 */
export function ReauthDialog() {
	const open = useReauth((s) => s.open);
	const qc = useQueryClient();
	const [viewer, setViewer] = useState<Viewer | null | undefined>(undefined);
	const [email, setEmail] = useState("");
	const [step, setStep] = useState<"email" | "code">("email");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Turnstile (when on) guards the code send here too.
	const config = useQuery({ ...publicConfigQuery(), enabled: open });
	const turnstile = useTurnstile(config.data?.turnstileSiteKey);

	useEffect(() => {
		if (!open) return;
		const v = qc.getQueryData<Viewer | null>(sessionKey);
		setViewer(v);
		setEmail(v?.email ?? "");
		setStep("email");
		setCode("");
		setError(null);
	}, [open, qc]);

	const guest = viewer?.isAnonymous === true;

	const cancel = () => {
		useReauth.getState().finish();
	};

	async function send(e?: FormEvent) {
		e?.preventDefault();
		const address = email.trim();
		if (!address) return;
		setBusy(true);
		setError(null);
		const captcha = await turnstile.token();
		if (turnstile.enabled && !captcha) {
			setBusy(false);
			return setError(authErrorMessage({ code: "CAPTCHA_PENDING" }));
		}
		const { error: err } = await authClient.emailOtp.sendVerificationOtp(
			{ email: address, type: "sign-in" },
			captcha ? { headers: { "x-captcha-response": captcha } } : undefined,
		);
		turnstile.reset();
		setBusy(false);
		if (err) return setError(authErrorMessage(err));
		setStep("code");
	}

	async function verify(e?: FormEvent) {
		e?.preventDefault();
		if (busy || code.length !== 6) return;
		setBusy(true);
		setError(null);
		const { data, error: err } = await authClient.signIn.emailOtp({
			email: email.trim(),
			otp: code,
		});
		setBusy(false);
		if (err || !data) {
			setCode("");
			return setError(authErrorMessage(err ?? null));
		}
		const sameAccount = !viewer || viewer.id === data.user.id;
		const pending = useReauth.getState().finish();
		await qc.invalidateQueries({ queryKey: sessionKey });
		if (!sameAccount) {
			// Someone else signed in: nothing of the old account's runs as them.
			window.location.reload();
			return;
		}
		// The live channel and notes authenticated with the old cookie.
		reconnectCollabClient();
		for (const retry of pending) retry();
	}

	return (
		<Dialog open={open} onOpenChange={(o) => (o ? undefined : cancel())}>
			<DialogContent data-testid="reauth-dialog" className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Sign in again</DialogTitle>
					<DialogDescription>
						{guest
							? "Your guest session ended. Open the trip again to keep going."
							: "Your session ended. Sign in to keep going; you'll stay right here."}
					</DialogDescription>
				</DialogHeader>
				{guest ? (
					<DialogFooter>
						<Button onClick={() => window.location.reload()}>
							Open the trip again
						</Button>
					</DialogFooter>
				) : step === "email" ? (
					<form onSubmit={send} className="grid gap-3">
						<Label htmlFor="reauth-email">Email</Label>
						<Input
							id="reauth-email"
							type="email"
							autoComplete="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? "reauth-error" : undefined}
						/>
						{error ? (
							<p
								id="reauth-error"
								role="alert"
								className="text-sm text-destructive"
							>
								{error}
							</p>
						) : null}
						<Turnstile controller={turnstile} />
						<DialogFooter>
							<Button variant="ghost" asChild>
								<a href={LOGIN_PATH}>Use the sign-in page</a>
							</Button>
							<Button type="submit" disabled={busy || !email.trim()}>
								Send code
							</Button>
						</DialogFooter>
					</form>
				) : (
					<form onSubmit={verify} className="grid gap-3">
						<Label htmlFor="reauth-code">Code sent to {email.trim()}</Label>
						<Input
							id="reauth-code"
							inputMode="numeric"
							autoComplete="one-time-code"
							maxLength={6}
							autoFocus
							value={code}
							onChange={(e) =>
								setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
							}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? "reauth-error" : undefined}
						/>
						{error ? (
							<p
								id="reauth-error"
								role="alert"
								className="text-sm text-destructive"
							>
								{error}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								disabled={busy}
								onClick={() => {
									setCode("");
									void send();
								}}
							>
								Send a new code
							</Button>
							<Button type="submit" disabled={busy || code.length !== 6}>
								Sign in
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
