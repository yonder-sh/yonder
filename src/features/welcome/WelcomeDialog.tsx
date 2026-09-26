/**
 * The welcome for people who join a trip (owner, 2026-09-25), the first
 * time they open a trip they didn't create (once per person and trip, on
 * any device), and again from the trip menu's "How this trip works":
 *
 *   [cover photo, or the route sketch]
 *   “Rate the Kyoto places before Sunday!” — Maya
 *   Summer in Japan
 *   Fri 2 – Thu 15 Oct · Tokyo, Kyoto, Osaka
 *   Maya invited you · with Dennis, Audrey
 *   Where things stand …
 *   [ Rate 48 places ]   Look around
 *
 * Guests without an account first say what the group should call them. It
 * ends with the notifications ask (a tap, so the browser may prompt), and
 * the in-app notifications card then stays away. A proper dialog: focus
 * moves in and back, Escape is "Look around"; a full-screen sheet on phones.
 * Viewers get "See the plan" and "Ask Dennis for edit access" (a message to
 * copy: there is no request inbox to send it to).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import { BellRing, CircleHelp, Copy, Share } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { TripSketch } from "@/features/home/TripSketch";
import { tripRoute } from "@/features/overview/lib/trip-route";
import { useStanding } from "@/features/overview/use-standing";
import { WhereThingsStand } from "@/features/overview/WhereThingsStand";
import { lastReviewView } from "@/features/places/tab/use-places";
import {
	enablePush,
	markPromptSeen,
	permission,
	pushEnv,
} from "@/features/push/push-client";
import {
	pushSettingsKey,
	useHasAccount,
	usePushSettings,
} from "@/features/push/use-push";
import { canRateOwn } from "@/lib/auth/roles";
import { renameGuest } from "@/lib/auth/share.functions";
import { humanError } from "@/lib/errors";
import { mediaUrl } from "@/lib/media-url";
import { sessionKey, tripKeys } from "@/lib/query/keys";
import { sessionQuery } from "@/lib/query/trip-queries";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { WELCOME_TESTID as T } from "./testids";
import {
	getWelcome,
	markWelcomeSeen,
	type WelcomeInfo,
} from "./welcome.functions";
import {
	accessRequest,
	datesLine,
	primaryAction,
	whoLine,
} from "./welcome-logic";
import { useWelcome } from "./welcome-store";

/** e2e: the welcome opens by itself only when a spec asks for it. */
export const E2E_WELCOME_KEY = "yonder.e2e.welcome";

export const welcomeKey = (tripId: string) => ["tripWelcome", tripId] as const;

function suppressed(): boolean {
	if (import.meta.env.VITE_E2E !== "1") return false;
	try {
		return localStorage.getItem(E2E_WELCOME_KEY) !== "1";
	} catch {
		return true;
	}
}

/**
 * Mounted once in the live workspace: asks the server whether to show the
 * welcome for this trip, opens it, and settles the store either way.
 */
export function WelcomeGate() {
	const { graph } = useWorkspace();
	const tripId = graph.trip.id;
	const setStatus = useWelcome((s) => s.setStatus);
	const q = useQuery({
		queryKey: welcomeKey(tripId),
		queryFn: () => getWelcome({ data: { tripId } }),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const settled = useRef<string | null>(null);
	useEffect(() => {
		if (settled.current === tripId) return;
		if (q.isError) {
			settled.current = tripId;
			setStatus("done");
		} else if (q.data) {
			settled.current = tripId;
			setStatus(q.data.show && !suppressed() ? "open" : "done");
		} else setStatus("pending");
	}, [q.data, q.isError, tripId, setStatus]);
	// Another trip later: its own answer.
	useEffect(() => () => setStatus("pending"), [setStatus]);
	return <WelcomeDialog info={q.data} />;
}

export function WelcomeDialog({ info }: { info: WelcomeInfo | undefined }) {
	const { graph, mode, access } = useWorkspace();
	const open = useWelcome((s) => s.open);
	const close = useWelcome((s) => s.close);
	const qc = useQueryClient();
	const tripId = graph.trip.id;
	const live = mode === "live";
	const session = useQuery({ ...sessionQuery(), enabled: live });
	const anonymous =
		!!session.data?.isAnonymous || (access.isGuest && !session.data);
	// The name step only on the first, automatic open.
	const first = !!info?.show;
	const [step, setStep] = useState<"name" | "main">("main");
	const notified = useRef(false);
	useEffect(() => {
		if (open) setStep(first && anonymous ? "name" : "main");
	}, [open, first, anonymous]);

	const done = () => {
		close();
		if (notified.current) markPromptSeen();
		if (!live) return;
		qc.setQueryData<WelcomeInfo>(welcomeKey(tripId), (old) =>
			old ? { ...old, show: false } : old,
		);
		void markWelcomeSeen({ data: { tripId } }).catch(() => {
			// Offline or a blip: it simply shows again next time.
		});
	};

	return (
		<Dialog open={open} onOpenChange={(v) => (v ? null : done())}>
			<DialogContent
				data-testid={T.dialog}
				data-step={step}
				showCloseButton={false}
				aria-describedby={undefined}
				// Focus lands on the step's main control (the name, or the button).
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					const box = e.currentTarget as HTMLElement | null;
					const el = box?.querySelector<HTMLElement>("[data-autofocus]");
					(el ?? box)?.focus({ preventScroll: true });
				}}
				className={cn(
					"max-h-[calc(100svh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[480px]",
					// Phones: a full-screen sheet.
					"max-sm:top-0 max-sm:left-0 max-sm:h-[100svh] max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0",
				)}
			>
				{step === "name" ? (
					<NameStep onDone={() => setStep("main")} />
				) : (
					<MainStep
						info={info}
						onClose={done}
						onNotifyShown={() => {
							notified.current = true;
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** "What should the group call you?" (guests without an account). */
function NameStep({ onDone }: { onDone: () => void }) {
	const { graph } = useWorkspace();
	const qc = useQueryClient();
	const location = useLocation();
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: (n: string) => renameGuest({ data: { name: n } }),
		meta: { silent: true },
		onSuccess: async () => {
			await Promise.all([
				qc.invalidateQueries({ queryKey: sessionKey }),
				qc.invalidateQueries({ queryKey: tripKeys.graph(graph.trip.id) }),
			]);
			onDone();
		},
		onError: (e) => setError(humanError(e)),
	});
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const n = name.trim();
		if (!n) return onDone();
		save.mutate(n);
	};
	const next = `${location.pathname}${location.searchStr ?? ""}`;
	return (
		<form
			onSubmit={submit}
			data-testid={T.nameStep}
			className="grid gap-4 p-6 max-sm:pt-[calc(env(safe-area-inset-top)+2.5rem)]"
		>
			<DialogTitle className="font-display text-[22px] leading-7 font-semibold">
				What should the group call you?
			</DialogTitle>
			<DialogDescription className="-mt-2">
				Your name shows next to what you do on {graph.trip.name}.
			</DialogDescription>
			<div className="grid gap-1.5">
				<Input
					data-autofocus
					value={name}
					maxLength={40}
					placeholder={graph.me.name}
					aria-label="Your name"
					aria-invalid={!!error}
					data-testid={T.nameInput}
					onChange={(e) => {
						setName(e.target.value);
						setError(null);
					}}
				/>
				{error ? (
					<p className="text-[13px] text-destructive" role="alert">
						{error}
					</p>
				) : null}
			</div>
			<p className="text-[13px] text-muted-foreground">
				{graph.me.role === "rater"
					? "Sign in to rate places and keep your ratings on other devices. "
					: "Sign in to keep this trip on your other devices. "}
				<Link
					to="/login"
					search={{ next } as never}
					data-testid={T.signIn}
					className="font-medium text-primary hover:underline"
				>
					Sign in
				</Link>
			</p>
			<Button
				type="submit"
				disabled={save.isPending}
				data-testid={T.nameContinue}
				className="justify-self-start"
			>
				Continue
			</Button>
		</form>
	);
}

function MainStep({
	info,
	onClose,
	onNotifyShown,
}: {
	info: WelcomeInfo | undefined;
	onClose: () => void;
	onNotifyShown: () => void;
}) {
	const { graph, ix, access, nav } = useWorkspace();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const standing = useStanding();
	const route = useMemo(() => tripRoute(ix), [ix]);
	const [asking, setAsking] = useState(false);
	const cover = graph.trip.coverAttachmentId;
	const action = primaryAction({
		canRate: canRateOwn(access),
		myLeft: standing.myLeft,
		canEdit: access.mode !== "read",
		places: standing.places,
	});
	const owner = graph.members.find((m) => m.role === "owner");
	const ownerName = owner
		? (owner.firstName ?? owner.name.split(/\s+/)[0] ?? owner.name)
		: "the owner";
	const cities = useMemo(() => mainCities(ix, route), [ix, route]);
	const dates = datesLine(
		ix.days[0]?.date ?? null,
		ix.days.at(-1)?.date ?? null,
	);
	const who = whoLine({
		members: graph.members,
		me: access.memberId,
		meUserId: graph.me.userId,
		via: info?.via ?? null,
		invitedBy: info?.invitedBy ?? null,
		inviterUserId: info?.inviterUserId ?? null,
	});
	// After the name step: the button (the dialog's own open focus does the rest).
	const primary = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (primary.current && !primary.current.contains(document.activeElement))
			primary.current.focus({ preventScroll: true });
	}, []);
	const go = () => {
		onClose();
		if (action.kind === "rate")
			nav.openPlaces({
				scopeId: null,
				patch: { pv: "rate", pst: undefined, talk: undefined },
			});
		else if (action.kind === "add") {
			nav.openPlaces({ scopeId: null, patch: { pv: lastReviewView.current } });
			openAddPlace({ mode: "search" });
		} else nav.setTab("plan");
	};
	const points = route.stays.flatMap((s) => (s.coord ? [s.coord] : []));
	const countryCodes = ix
		.children(null)
		.flatMap((n) => (n.countryCode ? [n.countryCode] : []));
	const viewer = access.role === "viewer";
	return (
		<div className="flex min-h-full flex-col">
			<div className="relative h-36 shrink-0 overflow-hidden bg-muted sm:h-40 sm:rounded-t-lg">
				{cover ? (
					<img
						src={mediaUrl(cover, "display")}
						alt=""
						className="size-full object-cover"
					/>
				) : (
					<TripSketch
						seed={graph.trip.id}
						points={points}
						countryCodes={countryCodes}
						glow
					/>
				)}
			</div>
			<div className="flex flex-1 flex-col gap-4 p-5 sm:p-6">
				{info?.note ? (
					<figure
						data-testid={T.note}
						className="border-l-2 border-primary/50 pl-3 text-[15px]"
					>
						<blockquote className="italic">“{info.note.text}”</blockquote>
						<figcaption className="mt-0.5 text-[13px] text-muted-foreground">
							— {info.note.by}
						</figcaption>
					</figure>
				) : null}
				<div className="grid gap-1">
					<DialogTitle className="font-display text-[26px] leading-8 font-semibold text-balance break-words">
						{graph.trip.name}
					</DialogTitle>
					<p className="text-sm text-muted-foreground" data-testid={T.dates}>
						{[dates, cities].filter(Boolean).join(" · ")}
					</p>
					{who ? (
						<p className="text-sm" data-testid={T.who}>
							{who}
						</p>
					) : null}
				</div>
				<WhereThingsStand
					standing={standing}
					compact
					actions={false}
					onNavigate={onClose}
				/>
				<div className="flex flex-wrap items-center gap-2 pt-1 max-sm:mt-auto">
					<Button
						ref={primary}
						data-autofocus
						onClick={go}
						data-testid={T.primary}
						data-kind={action.kind}
					>
						{action.label}
					</Button>
					<Button variant="ghost" onClick={onClose} data-testid={T.lookAround}>
						Look around
					</Button>
					{viewer ? (
						<Button
							variant="link"
							className="px-1"
							onClick={() => setAsking((v) => !v)}
							aria-expanded={asking}
							data-testid={T.askAccess}
						>
							Ask {ownerName} for edit access
						</Button>
					) : null}
				</div>
				{viewer && asking ? (
					<AskAccess
						owner={ownerName}
						trip={graph.trip.name}
						slug={graph.trip.slug}
					/>
				) : null}
				{/* At the end: the notifications ask (a tap, so the browser may prompt). */}
				<WelcomeNotify onShown={onNotifyShown} />
			</div>
		</div>
	);
}

/** The route's cities, else the cities with the most places (three at most). */
function mainCities(
	ix: ReturnType<typeof useWorkspace>["ix"],
	route: ReturnType<typeof tripRoute>,
): string {
	const fromRoute = [...new Set(route.stays.map((s) => s.name))];
	if (fromRoute.length) return fromRoute.slice(0, 3).join(", ");
	const cities = ix.outline
		.filter((n) => n.type === "city")
		.map((c) => ({
			name: c.name,
			n: ix.outline.filter(
				(p) => p.type === "place" && p.id !== c.id && ix.isWithin(p.id, c.id),
			).length,
		}))
		.filter((c) => c.n > 0)
		.sort((a, b) => b.n - a.n);
	return cities
		.slice(0, 3)
		.map((c) => c.name)
		.join(", ");
}

/** A message to copy (or share) to the owner: nothing is sent for you. */
function AskAccess({
	owner,
	trip,
	slug,
}: {
	owner: string;
	trip: string;
	slug: string;
}) {
	const url =
		typeof window === "undefined"
			? `/t/${slug}`
			: `${window.location.origin}/t/${slug}`;
	const text = accessRequest({ owner, trip, url });
	const canShare =
		typeof navigator !== "undefined" && typeof navigator.share === "function";
	return (
		<div className="grid gap-2 rounded-lg bg-muted/60 p-3">
			<p className="text-[13px] text-muted-foreground">
				Only {owner} can change what you can do. Send them this, however you
				usually talk:
			</p>
			<textarea
				readOnly
				value={text}
				rows={3}
				onFocus={(e) => e.currentTarget.select()}
				data-testid={T.askText}
				aria-label={`Message to ${owner}`}
				className="w-full resize-none rounded-md border bg-background px-2.5 py-2 text-sm"
			/>
			<div className="flex gap-2">
				<Button
					size="sm"
					variant="outline"
					onClick={() =>
						void navigator.clipboard
							?.writeText(text)
							.then(() => toast.success("Message copied"))
							.catch(() => toast.message("Select the message to copy it"))
					}
				>
					<Copy /> Copy message
				</Button>
				{canShare ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => void navigator.share({ text }).catch(() => {})}
					>
						<Share /> Share…
					</Button>
				) : null}
			</div>
		</div>
	);
}

/**
 * "Turn on notifications for mentions and changes" (it follows a tap, so the
 * browser may ask); on an iPhone in a tab, how to add Yonder to the Home
 * Screen instead. Nothing once this device has decided, or without push.
 */
function WelcomeNotify({ onShown }: { onShown: () => void }) {
	const { mode } = useWorkspace();
	const live = mode === "live";
	const account = useHasAccount(live);
	const settings = usePushSettings(live && account);
	const qc = useQueryClient();
	const publicKey = settings.data?.publicKey ?? null;
	const [state, setState] = useState<
		"idle" | "busy" | "on" | "blocked" | "unavailable"
	>("idle");
	const env = typeof window === "undefined" ? "unsupported" : pushEnv();
	const show =
		!!publicKey &&
		env !== "unsupported" &&
		(env === "ios-install" || permission() === "default" || state !== "idle");
	useEffect(() => {
		if (show) onShown();
	}, [show, onShown]);
	if (!show || !publicKey) return null;
	if (env === "ios-install")
		return (
			<p
				data-testid={T.notify}
				data-kind="ios"
				className="flex gap-2 rounded-lg bg-muted/60 p-3 text-[13px] text-muted-foreground"
			>
				<Share className="mt-0.5 size-4 shrink-0 text-primary" />
				<span>
					To get notifications on this iPhone, add Yonder to your Home Screen
					first: tap <span className="font-medium text-foreground">Share</span>,
					then{" "}
					<span className="font-medium text-foreground">
						Add to Home Screen
					</span>
					, and open it from there.
				</span>
			</p>
		);
	const turnOn = async () => {
		setState("busy");
		try {
			const r = await enablePush(publicKey);
			setState(
				r === "on"
					? "on"
					: r === "denied"
						? "blocked"
						: r === "unavailable"
							? "unavailable"
							: "idle",
			);
			await qc.invalidateQueries({ queryKey: pushSettingsKey });
		} catch {
			setState("unavailable");
		}
	};
	return (
		<div data-testid={T.notify} data-state={state} className="text-[13px]">
			{state === "on" ? (
				<p className="flex items-center gap-2 text-muted-foreground">
					<BellRing className="size-4 text-primary" /> Notifications are on.
				</p>
			) : state === "blocked" ? (
				<p className="text-muted-foreground">
					Notifications are blocked. Allow them for Yonder in your browser's
					settings.
				</p>
			) : state === "unavailable" ? (
				<p className="text-muted-foreground">
					Notifications aren't available in this browser.
				</p>
			) : (
				<Button
					variant="outline"
					size="sm"
					disabled={state === "busy"}
					onClick={() => void turnOn()}
				>
					<BellRing /> Turn on notifications for mentions and changes
				</Button>
			)}
		</div>
	);
}

/** "How this trip works" in the trip menu: the welcome again. */
export function WelcomeMenuItem({ iconless = false }: { iconless?: boolean }) {
	const show = useWelcome((s) => s.show);
	return (
		<DropdownMenuItem onSelect={() => show()} data-testid={T.menuItem}>
			{iconless ? null : <CircleHelp />}
			How this trip works
		</DropdownMenuItem>
	);
}
