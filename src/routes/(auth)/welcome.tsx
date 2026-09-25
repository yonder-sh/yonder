import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/auth-client";
import { authErrorMessage } from "@/lib/auth/auth-errors";
import { AUTH_BRAND, LOGIN_PATH } from "@/lib/auth/constants";
import { PersonName } from "@/lib/auth/names";
import { postAuthDestination } from "@/lib/auth/redirect";
import { getSessionFn } from "@/lib/auth/session.functions";
import { signOut } from "@/lib/auth/sign-out";
import { AuthShell } from "./-components/auth-shell";

/**
 * `/welcome?next` (SPEC §11.2 flow 2, DESIGN §10.2): the onboarding gate.
 * Email OTP creates accounts without names, so every page that needs a named
 * user sends people here until both names are set. The server enforces the
 * same rule (`user.update` hook, `withNamedUser`).
 */
const Search = z.object({
	next: z.string().max(2048).optional().catch(undefined),
});

export const Route = createFileRoute("/(auth)/welcome")({
	validateSearch: Search,
	beforeLoad: async ({ search }) => {
		const next = postAuthDestination(search.next);
		const viewer = await getSessionFn();
		if (!viewer)
			throw redirect({
				href: `${LOGIN_PATH}?${new URLSearchParams({ next })}`,
			});
		// Guests have nothing to onboard; named accounts skip the step (QA AUTH-04).
		if (viewer.named) throw redirect({ href: next });
		return { viewer };
	},
	head: () => ({ meta: [{ title: `Welcome · ${AUTH_BRAND.name}` }] }),
	component: WelcomePage,
});

type Field = "firstName" | "lastName";

function WelcomePage() {
	const { viewer } = Route.useRouteContext();
	const { next } = Route.useSearch();
	const router = useRouter();
	const [values, setValues] = useState({
		firstName: viewer.firstName,
		lastName: viewer.lastName,
	});
	const [fieldErrors, setFieldErrors] = useState<
		Partial<Record<Field, string>>
	>({});
	const [formError, setFormError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ids = { firstName: useId(), lastName: useId(), form: useId() };

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		const first = PersonName.safeParse(values.firstName);
		const last = PersonName.safeParse(values.lastName);
		const errors: Partial<Record<Field, string>> = {};
		if (!first.success)
			errors.firstName = first.error.issues[0]?.message ?? "Required";
		if (!last.success)
			errors.lastName = last.error.issues[0]?.message ?? "Required";
		setFieldErrors(errors);
		if (!first.success || !last.success) {
			document
				.getElementById(errors.firstName ? ids.firstName : ids.lastName)
				?.focus();
			return;
		}
		setBusy(true);
		setFormError(null);
		const { error } = await authClient.updateUser({
			firstName: first.data,
			lastName: last.data,
		});
		if (error) {
			setBusy(false);
			setFormError(authErrorMessage(error));
			return;
		}
		await router.invalidate();
		await router.navigate({ href: postAuthDestination(next), replace: true });
	}

	const field = (name: Field, label: string, autoComplete: string) => (
		<div className="grid gap-2">
			<Label htmlFor={ids[name]}>{label}</Label>
			<Input
				id={ids[name]}
				autoComplete={autoComplete}
				autoFocus={name === "firstName"}
				required
				maxLength={80}
				value={values[name]}
				onChange={(e) => {
					setValues((v) => ({ ...v, [name]: e.target.value }));
					if (fieldErrors[name])
						setFieldErrors((f) => ({ ...f, [name]: undefined }));
				}}
				aria-invalid={fieldErrors[name] ? true : undefined}
				aria-describedby={fieldErrors[name] ? `${ids[name]}-error` : undefined}
				className="h-11 text-base"
				data-testid={`welcome-${name === "firstName" ? "first" : "last"}-name`}
			/>
			{fieldErrors[name] ? (
				<p id={`${ids[name]}-error`} className="text-[13px] text-destructive">
					{fieldErrors[name]}
				</p>
			) : null}
		</div>
	);

	return (
		<AuthShell
			title="What should we call you?"
			subtitle={
				<>
					Signed in as{" "}
					<span className="font-medium text-foreground">{viewer.email}</span>.{" "}
					<button
						type="button"
						onClick={() => void signOut()}
						className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
					>
						Not you?
					</button>
				</>
			}
		>
			<form
				onSubmit={onSubmit}
				noValidate
				className="grid gap-4"
				aria-describedby={formError ? ids.form : undefined}
			>
				<div className="grid gap-4 sm:grid-cols-2">
					{field("firstName", "First name", "given-name")}
					{field("lastName", "Last name", "family-name")}
				</div>
				{formError ? (
					<p
						id={ids.form}
						role="alert"
						className="text-[13px] text-destructive"
						data-testid="auth-error"
					>
						{formError}
					</p>
				) : null}
				<Button
					type="submit"
					size="lg"
					className="mt-2 h-11"
					disabled={busy}
					data-testid="welcome-submit"
				>
					{busy ? (
						<Loader2 className="animate-spin" aria-hidden="true" />
					) : null}
					Continue
				</Button>
				<p className="text-xs text-muted-foreground">
					Your name is shown to people you plan with.
				</p>
			</form>
		</AuthShell>
	);
}
