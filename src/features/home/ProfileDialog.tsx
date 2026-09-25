/**
 * Profile (SPEC §12.5 `ProfileDialog()`, DESIGN §8.10; ADDENDUM §7.2), opened
 * from the account menu (`useUi().setProfileOpen(true)`).
 *
 * - Photo (owner FB-16, `ProfilePhoto`): upload, change or remove a picture,
 *   placed with a circular crop; it shows wherever you appear.
 * - "Your name": first and last, both required, through Better Auth's
 *   `updateUser` (the server rebuilds `name`); names, presence and chips
 *   update everywhere (QA AUTH-15). The email is shown read-only.
 * - Display currency (ADDENDUM §7.2, view-only, per user): the trip's home
 *   currency (default), "Local" (the country you're looking at: ¥ in Japan,
 *   ₩ in Korea…; WP-Money converts), or a fixed currency. Synced through
 *   `setUserPrefs`; it never changes anyone else's view or any stored amount.
 * - Storage (ADDENDUM §12): "1.2 GB of 5 GB used" with a thin bar, for the
 *   photos, videos and PDFs this account uploaded in every trip.
 * - Link guests only rename themselves (`renameGuest`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useState } from "react";
import { toast } from "sonner";
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
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { formatBytes } from "@/features/media/media-kinds";
import { setUserPrefs } from "@/functions/prefs.functions";
import { getStorageUsage } from "@/functions/storage.functions";
import { authClient } from "@/lib/auth/auth-client";
import { renameGuest } from "@/lib/auth/share.functions";
import { humanError } from "@/lib/errors";
import { meKeys, sessionKey } from "@/lib/query/keys";
import { sessionQuery, userPrefsQuery } from "@/lib/query/trip-queries";
import type { UserPrefs } from "@/lib/schemas/misc";
import { TESTID } from "@/lib/testids";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { useUi } from "@/lib/workspace/ui-store";
import { currencyName, HOME_CURRENCIES } from "./currencies";
import { ProfilePhoto } from "./ProfilePhoto";
import { HOME_TESTID } from "./testids";

const HOME = "__home";

export function ProfileDialog() {
	const open = useUi((s) => s.profileOpen);
	const setOpen = useUi((s) => s.setProfileOpen);
	const ws = useWorkspaceOptional();
	const live = !ws || ws.mode === "live";
	const session = useQuery({ ...sessionQuery(), enabled: open && live });
	const guest = session.data?.isAnonymous ?? false;
	const prefs = useQuery({
		...userPrefsQuery(),
		enabled: open && live && !!session.data && !guest,
	});
	const qc = useQueryClient();
	const router = useRouter();
	const [first, setFirst] = useState("");
	const [last, setLast] = useState("");
	const [guestName, setGuestName] = useState("");
	const [currency, setCurrency] = useState<string>(HOME);
	const [error, setError] = useState<string | null>(null);
	// FB-16: while the photo is being cropped, the rest of the form steps aside.
	const [cropping, setCropping] = useState(false);
	const ids = {
		first: useId(),
		last: useId(),
		guest: useId(),
		cur: useId(),
		email: useId(),
	};
	useEffect(() => {
		if (open && session.data) {
			setFirst(session.data.firstName);
			setLast(session.data.lastName);
			setGuestName(session.data.name);
			setError(null);
		}
	}, [open, session.data]);
	useEffect(() => {
		if (!open) setCropping(false);
	}, [open]);
	useEffect(() => {
		if (open) setCurrency(prefs.data?.displayCurrency ?? HOME);
	}, [open, prefs.data]);
	const homeCurrency = ws?.graph.trip.settings.currency;

	const save = useMutation({
		meta: { silent: true },
		mutationFn: async () => {
			if (guest) {
				await renameGuest({ data: { name: guestName.trim() } });
				return;
			}
			const s = session.data;
			const nameChanged =
				first.trim() !== s?.firstName || last.trim() !== s?.lastName;
			if (nameChanged) {
				const { error } = await authClient.updateUser({
					firstName: first.trim(),
					lastName: last.trim(),
				});
				if (error) throw new Error(humanError(error));
			}
			const next: UserPrefs["displayCurrency"] =
				currency === HOME ? null : currency;
			if (next !== (prefs.data?.displayCurrency ?? null))
				await setUserPrefs({ data: { displayCurrency: next } });
		},
		onSuccess: async () => {
			await Promise.all([
				qc.invalidateQueries({ queryKey: sessionKey }),
				qc.invalidateQueries({ queryKey: meKeys.prefs }),
				qc.invalidateQueries({ queryKey: ["trip"] }),
			]);
			await router.invalidate();
			setOpen(false);
			toast.success("Saved");
		},
		onError: (e) => setError(humanError(e)),
	});
	const valid = guest
		? guestName.trim().length > 0 && guestName.trim().length <= 40
		: !!first.trim() && !!last.trim();
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (valid) save.mutate();
	};
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-[420px]"
				data-testid={TESTID.profileDialog}
			>
				<form onSubmit={submit} className="grid gap-5">
					<DialogHeader>
						<DialogTitle className="text-xl">
							{guest ? "Your name" : "Profile"}
						</DialogTitle>
						<DialogDescription>
							{guest
								? "Shown to the people on this trip while you're a guest."
								: "Your photo and name are shown to people you plan with. How money shows is just for you."}
						</DialogDescription>
					</DialogHeader>
					{guest ? (
						<div className="grid gap-2">
							<Label htmlFor={ids.guest}>Name</Label>
							<Input
								id={ids.guest}
								value={guestName}
								maxLength={40}
								onChange={(e) => setGuestName(e.target.value)}
							/>
						</div>
					) : (
						<>
							{session.data ? (
								<ProfilePhoto
									viewer={session.data}
									color={ws?.graph.me.color ?? 0}
									onCroppingChange={setCropping}
								/>
							) : null}
							{/* Hidden, not unmounted: typed names survive a crop. */}
							<div className="contents" hidden={cropping}>
								<div className="grid gap-4 sm:grid-cols-2">
									<div className="grid gap-2">
										<Label htmlFor={ids.first}>First name</Label>
										<Input
											id={ids.first}
											value={first}
											required
											maxLength={60}
											autoComplete="given-name"
											data-testid={HOME_TESTID.profileFirst}
											onChange={(e) => setFirst(e.target.value)}
										/>
									</div>
									<div className="grid gap-2">
										<Label htmlFor={ids.last}>Last name</Label>
										<Input
											id={ids.last}
											value={last}
											required
											maxLength={60}
											autoComplete="family-name"
											data-testid={HOME_TESTID.profileLast}
											onChange={(e) => setLast(e.target.value)}
										/>
									</div>
								</div>
								{session.data?.email ? (
									<div className="grid gap-2">
										<Label htmlFor={ids.email}>Email</Label>
										<Input
											id={ids.email}
											value={session.data.email}
											readOnly
											className="bg-muted/50 text-muted-foreground"
										/>
									</div>
								) : null}
								<StorageMeter enabled={open && live && !!session.data} />
								<div className="grid gap-2">
									<Label htmlFor={ids.cur}>Show money in</Label>
									<Select value={currency} onValueChange={setCurrency}>
										<SelectTrigger
											id={ids.cur}
											className="w-full"
											data-testid={HOME_TESTID.profileCurrency}
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={HOME}>
												The trip's home currency
												{homeCurrency ? (
													<span className="font-mono text-xs text-muted-foreground">
														{homeCurrency}
													</span>
												) : null}
											</SelectItem>
											<SelectItem value="local">
												Local — ¥ in Japan, ₩ in Korea…
											</SelectItem>
											<SelectSeparator />
											{HOME_CURRENCIES.map((c) => (
												<SelectItem key={c} value={c}>
													<span className="font-mono text-xs">{c}</span>{" "}
													{currencyName(c)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<p className="text-xs text-muted-foreground">
										Only for you. Totals show as “≈” in this currency; each
										expense keeps its own, and balances stay in the trip's.
									</p>
								</div>
							</div>
						</>
					)}
					{error ? (
						<p className="text-[13px] text-destructive" role="alert">
							{error}
						</p>
					) : null}
					<DialogFooter hidden={cropping}>
						<Button
							type="submit"
							disabled={save.isPending || !valid}
							data-testid={HOME_TESTID.profileSave}
						>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** ADDENDUM §12: the account's storage, "1.2 GB of 5 GB used" and a thin bar. */
function StorageMeter({ enabled }: { enabled: boolean }) {
	const usage = useQuery({
		queryKey: meKeys.storage,
		queryFn: () => getStorageUsage(),
		enabled,
	});
	const u = usage.data;
	if (!u) return null;
	const pct =
		u.quotaBytes > 0 ? Math.min(100, (u.usedBytes / u.quotaBytes) * 100) : 100;
	return (
		<div className="grid gap-1.5" data-testid={HOME_TESTID.profileStorage}>
			<div className="flex items-baseline justify-between gap-3 text-sm">
				<span className="font-medium">Storage</span>
				<span className="text-muted-foreground tabular-nums">
					{formatBytes(u.usedBytes)} of {formatBytes(u.quotaBytes)} used
				</span>
			</div>
			<Progress
				value={pct}
				aria-label="Storage used"
				className={
					pct >= 90 ? "h-1 bg-destructive/20 [&>*]:bg-destructive" : "h-1"
				}
			/>
			<p className="text-xs text-muted-foreground">
				Photos, videos and PDFs you upload, in every trip.
			</p>
		</div>
	);
}
