import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ArrowRight, Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Turnstile, useTurnstile } from "@/components/common/turnstile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/auth-client";
import {
	type AuthErrorLike,
	authErrorMessage,
	needsNewCode,
} from "@/lib/auth/auth-errors";
import { AUTH_BRAND, WELCOME_PATH } from "@/lib/auth/constants";
import { hasFullName } from "@/lib/auth/names";
import { publicConfigQuery } from "@/lib/auth/public-config.functions";
import { postAuthDestination } from "@/lib/auth/redirect";
import { getSessionFn } from "@/lib/auth/session.functions";
import { AuthShell } from "./-components/auth-shell";
import { OtpField } from "./-components/otp-field";

/**
 * `/login?next` (SPEC §11.2 flow 1, DESIGN §10.1): email, then a 6-digit code
 * that submits itself. The same screen signs up new people (email OTP creates
 * the account) and never says whether an email already has one. Guests
 * (anonymous sessions) may use it to upgrade: their grants follow them.
 * With Turnstile on (a runtime site key), every code sent carries a fresh
 * token: the widget sits on the email step and, invisible unless it needs a
 * click, behind "Resend code".
 */
const Search = z.object({
	next: z.string().max(2048).optional().catch(undefined),
});

export const Route = createFileRoute("/(auth)/login")({
	validateSearch: Search,
	beforeLoad: async ({ search }) => {
		const viewer = await getSessionFn();
		if (viewer && !viewer.isAnonymous) {
			const next = postAuthDestination(search.next);
			throw redirect({ href: viewer.named ? next : welcomeHref(next) });
		}
	},
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(publicConfigQuery()),
	head: () => ({ meta: [{ title: `Sign in · ${AUTH_BRAND.name}` }] }),
	component: LoginPage,
});

const RESEND_SECONDS = 60;
const EmailSchema = z.email();

function welcomeHref(next: string): string {
	return `${WELCOME_PATH}?${new URLSearchParams({ next })}`;
}

/** Reads Better Auth's `X-Retry-After` (seconds) from a failed call. */
function retryAfterFrom(response: Response | undefined): number | null {
	const v = Number(
		response?.headers.get("X-Retry-After") ??
			response?.headers.get("Retry-After"),
	);
	return Number.isFinite(v) && v > 0 ? Math.ceil(v) : null;
}

function formatCountdown(s: number): string {
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function LoginPage() {
	const { next } = Route.useSearch();
	const router = useRouter();
	const [step, setStep] = useState<"email" | "code">("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{
		message: string;
		newCode: boolean;
	} | null>(null);
	const [resendIn, setResendIn] = useState(0);
	const emailRef = useRef<HTMLInputElement>(null);
	const codeRef = useRef<HTMLInputElement>(null);
	const errorId = useId();
	const emailId = useId();
	const config = useQuery(publicConfigQuery());
	const turnstile = useTurnstile(config.data?.turnstileSiteKey);

	useEffect(() => {
		if (resendIn <= 0) return;
		const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
		return () => clearTimeout(t);
	}, [resendIn]);

	function showError(
		e: AuthErrorLike | null,
		retryAfter: number | null = null,
	) {
		setError({
			message: authErrorMessage(e, retryAfter),
			newCode: needsNewCode(e),
		});
	}

	async function sendCode(address: string): Promise<boolean> {
		setBusy(true);
		setError(null);
		const captcha = await turnstile.token();
		if (turnstile.enabled && !captcha) {
			setBusy(false);
			showError({ code: "CAPTCHA_PENDING" });
			return false;
		}
		let retryAfter: number | null = null;
		const { error: err } = await authClient.emailOtp.sendVerificationOtp(
			{ email: address, type: "sign-in" },
			{
				...(captcha ? { headers: { "x-captcha-response": captcha } } : {}),
				onError: (ctx) => {
					retryAfter = retryAfterFrom(ctx.response);
				},
			},
		);
		// A token is good for one send: the next one needs a fresh token.
		turnstile.reset();
		setBusy(false);
		if (err) {
			showError(err, retryAfter);
			return false;
		}
		setResendIn(RESEND_SECONDS);
		return true;
	}

	async function onSubmitEmail(e: FormEvent) {
		e.preventDefault();
		const address = email.trim();
		if (!EmailSchema.safeParse(address).success) {
			showError({ code: "INVALID_EMAIL" });
			emailRef.current?.focus();
			return;
		}
		setEmail(address);
		if (await sendCode(address)) {
			setCode("");
			setStep("code");
		}
	}

	async function verify(otp: string) {
		if (busy) return;
		setBusy(true);
		setError(null);
		let retryAfter: number | null = null;
		const { data, error: err } = await authClient.signIn.emailOtp(
			{ email, otp },
			{
				onError: (ctx) => {
					retryAfter = retryAfterFrom(ctx.response);
				},
			},
		);
		if (err || !data) {
			setBusy(false);
			setCode("");
			showError(err ?? null, retryAfter);
			requestAnimationFrame(() => codeRef.current?.focus());
			return;
		}
		const dest = postAuthDestination(next);
		await router.invalidate();
		await router.navigate({
			href: hasFullName(data.user) ? dest : welcomeHref(dest),
			replace: true,
		});
	}

	async function resend() {
		setCode("");
		if (await sendCode(email))
			requestAnimationFrame(() => codeRef.current?.focus());
	}

	function changeEmail() {
		setStep("email");
		setCode("");
		setError(null);
		requestAnimationFrame(() => emailRef.current?.select());
	}

	if (step === "email") {
		return (
			<AuthShell
				title="Plan the trip, together."
				subtitle="Sign in or create an account with your email. We'll send you a 6-digit code."
			>
				<form onSubmit={onSubmitEmail} noValidate className="grid gap-3">
					<Label htmlFor={emailId}>Email</Label>
					<Input
						id={emailId}
						ref={emailRef}
						type="email"
						inputMode="email"
						autoComplete="email"
						autoCapitalize="none"
						spellCheck={false}
						autoFocus
						placeholder="you@example.com"
						value={email}
						onChange={(e) => {
							setEmail(e.target.value);
							if (error) setError(null);
						}}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? errorId : undefined}
						className="h-11 text-base"
						data-testid="login-email"
					/>
					{error ? <ErrorText id={errorId} message={error.message} /> : null}
					<Turnstile controller={turnstile} className="mt-1" />
					<Button
						type="submit"
						size="lg"
						className="mt-2 h-11"
						disabled={busy}
						data-testid="login-submit"
					>
						{busy ? (
							<Loader2 className="animate-spin" aria-hidden="true" />
						) : null}
						Continue
						{busy ? null : <ArrowRight aria-hidden="true" />}
					</Button>
				</form>
			</AuthShell>
		);
	}

	return (
		<AuthShell
			title="Check your email"
			subtitle={
				<>
					Enter the 6-digit code we sent to{" "}
					<span className="font-medium text-foreground">{email}</span>.
				</>
			}
		>
			<div className="grid gap-4">
				<OtpField
					inputRef={codeRef}
					value={code}
					onChange={(v) => {
						setCode(v);
						if (error && !error.newCode) setError(null);
					}}
					onComplete={verify}
					disabled={busy || error?.newCode}
					invalid={Boolean(error)}
					describedBy={error ? errorId : undefined}
				/>
				<div aria-live="polite" className="min-h-5">
					{busy ? (
						<p className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />{" "}
							Checking…
						</p>
					) : error ? (
						<ErrorText id={errorId} message={error.message} />
					) : null}
				</div>
				{error?.newCode ? (
					<Button
						type="button"
						size="lg"
						className="h-11"
						onClick={resend}
						disabled={busy}
						data-testid="otp-new-code"
					>
						Send a new code
					</Button>
				) : null}
				<Turnstile controller={turnstile} appearance="interaction-only" />
				<p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
					{resendIn > 0 ? (
						<span data-testid="otp-resend-countdown">
							Resend in{" "}
							<span className="font-mono tabular-nums">
								{formatCountdown(resendIn)}
							</span>
						</span>
					) : (
						<button
							type="button"
							onClick={resend}
							disabled={busy}
							className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
							data-testid="otp-resend"
						>
							Resend code
						</button>
					)}
					<span aria-hidden="true">·</span>
					<button
						type="button"
						onClick={changeEmail}
						className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
					>
						Change email
					</button>
				</p>
			</div>
		</AuthShell>
	);
}

function ErrorText({ id, message }: { id: string; message: string }) {
	return (
		<p
			id={id}
			role="alert"
			className="text-[13px] text-destructive"
			data-testid="auth-error"
		>
			{message}
		</p>
	);
}
