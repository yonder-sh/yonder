/**
 * E8 Share to Yonder (EXTENSIONS §10): the page shares land on. The service
 * worker's share target stores the entry in IndexedDB `yonder-share/inbox`
 * and redirects here (`/share?id=`); the iOS Shortcut and ⌘K hand a link
 * over in the address (`/share?url=&text=&title=`); "Paste a link" works
 * anywhere.
 *
 * A link (or words) goes straight into Saved (`saveSharedLink`) and opens
 * there, in the Saved feed, ready to save to a trip with one tap or keep for
 * later. Offline it waits on this device (`useSharedUpload` sends it when
 * the app is back online). Photos and videos upload right here, in the
 * foreground with their progress ("Uploading 3 photos…"), and open in the
 * feed once they're all up; if the page closes or the network drops, they
 * stay on the device and carry on the next time the app opens.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ClipboardPaste, Film } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { YonderMark } from "@/components/common/yonder-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	deleteShared,
	getShared,
	putShared,
	type SharedEntry,
} from "@/features/offline/share-store";
import { saveSharedLink } from "@/features/saved/saved.functions";
import {
	type ShareProgress,
	uploadingLabel,
	uploadShare,
} from "@/features/saved/upload-shared";
import { humanError } from "@/lib/errors";
import { TESTID } from "@/lib/testids";
import { SaveFromAppsDialog } from "./SaveFromAppsDialog";
import { firstUrl } from "./share-classify";
import { HOME_TESTID } from "./testids";
import { SHARED_CHANGED } from "./use-shortcut-pickup";

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="min-h-svh bg-background">
			<header className="mx-auto flex h-14 max-w-[560px] items-center justify-between px-4">
				<Link
					to="/dashboard"
					className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-4" /> Your trips
				</Link>
				<YonderMark className="size-5 text-primary" />
			</header>
			<main
				data-testid={TESTID.shareInbox}
				className="mx-auto grid max-w-[560px] grid-cols-1 gap-4 px-4 pb-12"
			>
				{children}
			</main>
		</div>
	);
}

/** An entry from `/share?url=&text=&title=` (the iOS Shortcut sends the shared link as `url`). */
export function directEntry(d: {
	url?: string;
	text?: string;
	title?: string;
}): SharedEntry | null {
	const url = firstUrl(d.url ?? "") ?? firstUrl(d.text ?? "");
	const text = (url ? (d.text ?? "").replace(url, " ") : (d.text ?? "")).trim();
	if (!url && !text) return null;
	return {
		id: `link-${Date.now().toString(36)}`,
		createdAt: Date.now(),
		title: d.title?.trim() || null,
		text: text ? text.slice(0, 2000) : null,
		url,
		files: [],
	};
}

function PasteLink({ onEntry }: { onEntry: (e: SharedEntry) => void }) {
	const [text, setText] = useState("");
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const url = firstUrl(text);
		// The words around a pasted link name the idea ("Matcha at Tsujiri https://…").
		const rest = url ? text.replace(url, " ").trim() : text.trim();
		onEntry({
			id: `paste-${Date.now().toString(36)}`,
			createdAt: Date.now(),
			title: null,
			text: rest ? rest.slice(0, 2000) : null,
			url,
			files: [],
		});
	};
	return (
		<form onSubmit={submit} className="flex gap-2">
			<Input
				autoFocus
				value={text}
				onChange={(e) => setText(e.target.value)}
				placeholder="Paste a link or some text"
				aria-label="Paste a link"
				data-testid={HOME_TESTID.sharePaste}
				className="flex-1"
			/>
			<Button type="submit" variant="outline" disabled={!text.trim()}>
				<ClipboardPaste /> Use
			</Button>
		</form>
	);
}

/**
 * A link or words: into Saved, then open there (the feed, at it). Offline,
 * or if the server can't be reached, it waits on this device.
 */
function ToSaved({ entry, stored }: { entry: SharedEntry; stored: boolean }) {
	const navigate = useNavigate();
	const [kept, setKept] = useState<null | "offline" | "failed">(null);
	const started = useRef(false);
	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const keep = async (why: "offline" | "failed") => {
			if (!stored) await putShared(entry).catch(() => {});
			window.dispatchEvent(new Event(SHARED_CHANGED));
			setKept(why);
		};
		if (!navigator.onLine) {
			void keep("offline");
			return;
		}
		void saveSharedLink({
			data: {
				url: entry.url,
				text: entry.text,
				title: entry.title,
				clientId: entry.id,
			},
		})
			.then(async ({ id }) => {
				await deleteShared(entry.id).catch(() => {});
				window.dispatchEvent(new Event(SHARED_CHANGED));
				await navigate({
					to: "/saved",
					search: { open: id, from: "share" },
					replace: true,
				});
			})
			.catch(() => void keep("failed"));
	}, [entry, stored, navigate]);
	if (!kept)
		return (
			<div
				data-testid={HOME_TESTID.shareSaving}
				className="h-64 animate-pulse rounded-2xl bg-muted"
			/>
		);
	return (
		<EmptyState
			className="rounded-2xl border bg-card py-10"
			line={
				kept === "offline"
					? "You're offline. It's kept on this device and goes to Saved when you're back online."
					: "Couldn't reach Yonder. It's kept on this device and goes to Saved in a moment."
			}
			action={
				<Button asChild variant="outline">
					<Link to="/dashboard">Your trips</Link>
				</Button>
			}
		/>
	);
}

/**
 * Photos and videos: up to Saved now, with progress; then the feed at them.
 * Stopped (offline, the page closed): the entry stays on the device and the
 * app carries on with it later (`useSharedUpload`).
 */
function UploadToSaved({ entry }: { entry: SharedEntry }) {
	const navigate = useNavigate();
	const [progress, setProgress] = useState<ShareProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Retry
	useEffect(() => {
		let alive = true;
		setError(null);
		if (!navigator.onLine) {
			setError(
				"You're offline. They're kept on this device and go to Saved when you're back online.",
			);
			return;
		}
		void uploadShare(entry, (p) => alive && setProgress(p))
			.then(async (savedId) => {
				await deleteShared(entry.id).catch(() => {});
				window.dispatchEvent(new Event(SHARED_CHANGED));
				if (alive)
					await navigate({
						to: "/saved",
						search: { open: savedId, from: "share" },
						replace: true,
					});
			})
			.catch((e) => alive && setError(humanError(e)));
		return () => {
			alive = false;
		};
	}, [entry, navigate, attempt]);
	const label = uploadingLabel(entry.files);
	return (
		<div
			data-testid={HOME_TESTID.shareUploading}
			className="grid gap-4 rounded-2xl border bg-card p-5"
		>
			<div className="flex gap-2 overflow-x-auto">
				{entry.files.slice(0, 6).map((f) => (
					<FileThumb key={`${f.name}-${f.size}`} file={f} />
				))}
			</div>
			{error ? (
				<>
					<p className="text-sm" role="alert">
						{error}
					</p>
					<div className="flex gap-2">
						<Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
						<Button asChild variant="outline">
							<Link to="/saved">Saved</Link>
						</Button>
					</div>
				</>
			) : (
				<>
					<p className="text-sm font-medium">{label}</p>
					<div
						role="progressbar"
						aria-label={label}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round((progress?.fraction ?? 0) * 100)}
						className="h-1.5 overflow-hidden rounded-full bg-muted"
					>
						<div
							className="h-full rounded-full bg-primary transition-[width]"
							style={{
								width: `${Math.round((progress?.fraction ?? 0) * 100)}%`,
							}}
						/>
					</div>
					<p className="text-meta text-muted-foreground">
						Keep this open until it's done; if it stops, Yonder carries on next
						time.
					</p>
				</>
			)}
		</div>
	);
}

function FileThumb({ file }: { file: SharedEntry["files"][number] }) {
	const [src, setSrc] = useState<string | null>(null);
	useEffect(() => {
		if (!file.type.startsWith("image/")) return;
		const u = URL.createObjectURL(file.blob);
		setSrc(u);
		return () => URL.revokeObjectURL(u);
	}, [file]);
	return (
		<span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
			{src ? (
				<img src={src} alt="" className="size-full object-cover" />
			) : (
				<Film className="size-5 text-muted-foreground" />
			)}
		</span>
	);
}

export function ShareInbox({
	id,
	lost,
	direct,
}: {
	/** The IndexedDB entry id from `/share?id=`. */
	id?: string;
	/** `/share?lost=1`: the POST reached the server instead of the SW. */
	lost?: boolean;
	/** `/share?url=&text=&title=`: a link handed over in the address. */
	direct?: { url?: string; text?: string; title?: string };
}) {
	const [entry, setEntry] = useState<SharedEntry | null>(() =>
		direct ? directEntry(direct) : null,
	);
	const [loading, setLoading] = useState(!!id);
	const [howOpen, setHowOpen] = useState(false);
	useEffect(() => {
		if (!id) return;
		let alive = true;
		void getShared(id)
			.then((e) => alive && setEntry(e))
			.catch(() => alive && setEntry(null))
			.finally(() => alive && setLoading(false));
		return () => {
			alive = false;
		};
	}, [id]);
	return (
		<Shell>
			<div data-entry={id ?? ""} className="grid gap-4">
				<h1 className="pt-2 font-display text-2xl leading-7 font-semibold tracking-[-0.01em]">
					Save to Yonder
				</h1>
				{loading ? (
					<div className="h-64 animate-pulse rounded-2xl bg-muted" />
				) : entry?.files.length ? (
					<UploadToSaved entry={entry} />
				) : entry ? (
					<ToSaved entry={entry} stored={!!id && entry.id === id} />
				) : (
					<div className="grid gap-4 rounded-2xl border bg-card p-5">
						<EmptyState
							className="py-4"
							line={
								lost
									? "Couldn't receive that — share again."
									: "Nothing to save here."
							}
						/>
						<PasteLink onEntry={setEntry} />
						<button
							type="button"
							onClick={() => setHowOpen(true)}
							className="justify-self-start text-sm font-medium text-primary hover:underline"
						>
							Save from Instagram or TikTok on your phone
						</button>
					</div>
				)}
			</div>
			<SaveFromAppsDialog open={howOpen} onOpenChange={setHowOpen} />
		</Shell>
	);
}
