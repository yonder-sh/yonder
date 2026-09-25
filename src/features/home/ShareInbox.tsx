/**
 * E8 Share to Yonder (EXTENSIONS §10): the page the service worker's share
 * target redirects to (`/share?id=`). Reads the entry from IndexedDB
 * `yonder-share/inbox`, classifies it (Maps place / Social video / Web page /
 * Photos and videos / Text), and saves it with ONE tap on the defaults:
 * the last trip used, a cleaned name, "New idea" filed where the place
 * belongs. Maps links go through WP-Places' `resolveSharedLink` when it is
 * there (short links, place ids, the filing suggestion and `existing`), else
 * `parseMapsUrl` (name and coordinates → the nearest city). "Add to existing"
 * puts the link (or the photos) on a place already in the trip; a duplicate
 * ("Already in Asia 2027: Itoya (Ginza)") makes "Add link there" the primary
 * action and "Save as new idea" the secondary one.
 *
 * Suggesters' ideas become suggestions (the link chains onto the proposed
 * place through its client-chosen id); photos need edit access. Offline,
 * nothing is sent: the entry stays on this device (the dashboard shows "1
 * shared item waiting") for 7 days. iOS (no share target) gets "Paste a link".
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
	ArrowLeft,
	Check,
	ChevronRight,
	ChevronsUpDown,
	ClipboardPaste,
	Film,
	FolderTree,
	Globe,
	Image as ImageIcon,
	Lightbulb,
	MapPin,
	StickyNote,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { TypeGlyph } from "@/components/common/glyphs";
import { YonderMark } from "@/components/common/yonder-mark";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { createListItem } from "@/features/lists/lists.functions";
import { addLink } from "@/features/media/media.functions";
import { uploadOne } from "@/features/media/upload/uploader";
import {
	deleteShared,
	getShared,
	type SharedEntry,
} from "@/features/offline/share-store";
import * as placesFunctions from "@/features/places/places.functions";
import { createNode, createNodePath } from "@/functions/nodes.functions";
import { roleAtLeast } from "@/lib/auth/roles";
import { canNest } from "@/lib/engine/tree";
import type { GraphNode } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import { newId } from "@/lib/ids";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { tripGraphQuery } from "@/lib/query/trip-queries";
import { PLACE_CATEGORY_VALUES } from "@/lib/schemas/enums";
import { isProposed } from "@/lib/schemas/proposals";
import { TESTID } from "@/lib/testids";
import { myTripsQuery } from "./queries";
import {
	autoParent,
	classifyShare,
	cleanShareName,
	firstUrl,
	metres,
	normName,
	type ParentPlan,
	parentLabel,
	parseMapsUrl,
	readResolution,
	type ShareKind,
} from "./share-classify";
import { HOME_TESTID } from "./testids";
import type { MyTrip } from "./types";

const LAST_TRIP = "yonder:share-last-trip";

const KIND: Record<ShareKind, { label: string; icon: typeof Globe }> = {
	maps: { label: "Maps place", icon: MapPin },
	social: { label: "Social video", icon: Film },
	web: { label: "Web page", icon: Globe },
	media: { label: "Photos and videos", icon: ImageIcon },
	text: { label: "Text", icon: StickyNote },
};

/** Trips I can add to: members who edit or suggest, and edit/suggest links (never view or rate). */
function writable(t: MyTrip): boolean {
	return roleAtLeast(t.role, "suggester");
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="min-h-svh bg-background">
			<header className="mx-auto flex h-14 max-w-[560px] items-center justify-between px-4">
				<Link
					to="/"
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

type Where = { kind: "new" } | { kind: "existing"; nodeId: string };

type Resolver = (opts: {
	data: { tripId: string; url: string };
}) => Promise<unknown>;

/**
 * WP-Places' E8 resolver (`resolveSharedLink`), looked up at run time so this
 * page works before and after that package lands: without it, Maps links are
 * read by `parseMapsUrl` alone.
 */
function sharedLinkResolver(): Resolver | null {
	const mod = placesFunctions as unknown as Record<string, unknown>;
	const fn = mod.resolveSharedLink;
	return typeof fn === "function" ? (fn as Resolver) : null;
}

const CATEGORIES = new Set<string>(PLACE_CATEGORY_VALUES);

async function uploadFiles(
	tripId: string,
	nodeId: string,
	files: SharedEntry["files"],
): Promise<void> {
	// One PUT, or 16 MB parts for a bigger file (a shared video).
	for (const f of files)
		await uploadOne({
			tripId,
			target: { kind: "node", nodeId },
			blob: f.blob,
			type: f.type as never,
			name: f.name,
		});
}

/** The "in Kyoto · Change" chip: any country, region, city or area, or the top level. */
function ParentPicker({
	nodes,
	plan,
	label,
	onPick,
}: {
	nodes: readonly GraphNode[];
	plan: ParentPlan;
	label: string;
	onPick: (plan: ParentPlan) => void;
}) {
	const [open, setOpen] = useState(false);
	const options = useMemo(() => {
		const byParent = new Map<string | null, GraphNode[]>();
		for (const n of nodes)
			if (canNest(n.type, "place") && n.type !== "place") {
				const list = byParent.get(n.parentId) ?? [];
				list.push(n);
				byParent.set(n.parentId, list);
			}
		const out: { node: GraphNode; depth: number }[] = [];
		const walk = (pid: string | null, depth: number) => {
			for (const n of byParent.get(pid) ?? []) {
				out.push({ node: n, depth });
				walk(n.id, depth + 1);
			}
		};
		walk(null, 0);
		return out;
	}, [nodes]);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					data-testid={HOME_TESTID.shareParent}
					aria-label={`Filed in ${label}. Change`}
					className="inline-flex max-w-full items-center gap-1.5 justify-self-start rounded-full border bg-background px-2.5 text-[13px] leading-7 transition-colors hover:border-foreground/20"
				>
					<FolderTree className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="flex min-w-0 items-center gap-1">
						{label.split(" › ").map((part, i, all) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: a fixed path
								key={i}
								className={cn(
									"flex min-w-0 items-center gap-1",
									i < all.length - 1 && "text-muted-foreground",
								)}
							>
								{i ? <ChevronRight className="size-3 shrink-0" /> : null}
								<span className="truncate">{part}</span>
							</span>
						))}
					</span>
					<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-72 p-0" align="start">
				<Command>
					<CommandInput placeholder="Search the trip…" />
					<CommandList className="max-h-[50vh]">
						<CommandEmpty>No matches.</CommandEmpty>
						<CommandGroup>
							<CommandItem
								value="__top"
								onSelect={() => {
									onPick({ parentId: null, create: [] });
									setOpen(false);
								}}
							>
								<span className="flex-1">Top level</span>
								{plan.parentId === null && !plan.create.length ? (
									<Check className="size-4" />
								) : null}
							</CommandItem>
							{options.map(({ node, depth }) => (
								<CommandItem
									key={node.id}
									value={`${node.name} ${node.localName ?? ""} ${node.id}`}
									onSelect={() => {
										onPick({ parentId: node.id, create: [] });
										setOpen(false);
									}}
									style={{ paddingLeft: 8 + depth * 12 }}
								>
									<TypeGlyph type={node.type} category={node.category} />
									<span className="flex-1 truncate">{node.name}</span>
									{plan.parentId === node.id && !plan.create.length ? (
										<Check className="size-4" />
									) : null}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function Saver({ entry }: { entry: SharedEntry }) {
	const trips = useQuery(myTripsQuery());
	const qc = useQueryClient();
	const options = (trips.data ?? []).filter(writable);
	const [tripId, setTripId] = useState<string | null>(null);
	useEffect(() => {
		if (tripId || !options.length) return;
		let last: string | null = null;
		try {
			last = localStorage.getItem(LAST_TRIP);
		} catch {
			last = null;
		}
		setTripId(options.find((t) => t.id === last)?.id ?? options[0]?.id ?? null);
	}, [options, tripId]);
	const trip = options.find((t) => t.id === tripId) ?? null;
	const graph = useQuery({
		...tripGraphQuery(tripId ?? ""),
		enabled: !!tripId,
	});
	const kind = classifyShare(entry);
	const url = entry.url ?? firstUrl(entry.text);
	const hint = useMemo(
		() => (kind === "maps" && url ? parseMapsUrl(url) : null),
		[kind, url],
	);
	const offline = typeof navigator !== "undefined" && !navigator.onLine;
	const resolver = kind === "maps" ? sharedLinkResolver() : null;
	const resolved = useQuery({
		queryKey: ["share-resolve", tripId, url],
		queryFn: async () =>
			readResolution(
				await (resolver as Resolver)({
					data: { tripId: tripId as string, url: url as string },
				}),
			),
		enabled: !!resolver && !!tripId && !!url && !offline,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 5 * 60_000,
	});
	const found = resolved.data ?? null;
	const preview = found?.preview ?? null;
	const [name, setName] = useState(
		() => hint?.name ?? cleanShareName(entry.title, entry.text),
	);
	const [nameTouched, setNameTouched] = useState(false);
	useEffect(() => {
		if (preview?.name && !nameTouched) setName(preview.name.slice(0, 60));
	}, [preview?.name, nameTouched]);
	const at =
		preview !== null
			? { lat: preview.lat, lng: preview.lng }
			: hint?.lat != null && hint.lng != null
				? { lat: hint.lat, lng: hint.lng }
				: null;
	const [where, setWhere] = useState<Where>({ kind: "new" });
	const [picked, setPicked] = useState<ParentPlan | null>(null);
	const [state, setState] = useState<
		| { kind: "idle" }
		| { kind: "saving" }
		| {
				kind: "done";
				text: string;
				slug: string;
				sel?: string;
				note?: string;
		  }
		| { kind: "error"; text: string }
	>({ kind: "idle" });
	const nodes = graph.data?.nodes ?? [];
	const places = nodes.filter((n) => n.type === "place" || n.type === "area");
	const duplicate = useMemo(() => {
		const byServer = found?.existing
			? places.find((p) => p.id === found.existing?.nodeId)
			: null;
		if (byServer) return byServer;
		const n = normName(name);
		if (!n) return null;
		return (
			places.find(
				(p) =>
					normName(p.name) === n &&
					(at === null ||
						p.lat == null ||
						p.lng == null ||
						metres(at, { lat: p.lat, lng: p.lng }) <= 100),
			) ?? null
		);
	}, [name, places, at, found]);
	const duplicateId = duplicate?.id ?? null;
	useEffect(() => {
		if (duplicateId) setWhere({ kind: "existing", nodeId: duplicateId });
	}, [duplicateId]);
	// A new trip resets a hand-picked parent (its nodes are another trip's).
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on trip change only
	useEffect(() => setPicked(null), [tripId]);
	const plan: ParentPlan =
		picked ?? autoParent(nodes, at, preview?.filing ?? null);
	const planLabel = parentLabel(nodes, plan, trip?.name ?? "the trip");
	const unresolved =
		kind === "maps" &&
		!!resolver &&
		resolved.isFetched &&
		!preview &&
		!found?.existing &&
		at === null;
	const canUpload = trip
		? trip.role === "owner" || trip.role === "editor"
		: false;
	const K = KIND[kind];

	const save = async (mode: "default" | "todo" | "new" = "default") => {
		if (!trip) return;
		setState({ kind: "saving" });
		const asTodo = mode === "todo";
		const target: Where = mode === "new" ? { kind: "new" } : where;
		try {
			try {
				localStorage.setItem(LAST_TRIP, trip.id);
			} catch {
				// ignore
			}
			let nodeId: string | null =
				target.kind === "existing" ? target.nodeId : null;
			let suggested = false;
			if (asTodo) {
				const r = await createListItem({
					data: {
						tripId: trip.id,
						target: nodeId ? { kind: "node", nodeId } : { kind: "trip" },
						list: "todo",
						text: (name || entry.text || "Shared item").slice(0, 500),
						...(url ? { url } : {}),
					},
				});
				if (isProposed(r)) suggested = true;
			} else if (!nodeId) {
				// The id is chosen here, so a suggester's link can chain onto the
				// proposed place (EXTENSIONS §10 "chains via createdIds").
				const leafId = newId();
				const leaf = {
					type: "place" as const,
					name: name.trim() || "Shared idea",
					...(at ? { lat: at.lat, lng: at.lng } : {}),
					...(preview?.localName ? { localName: preview.localName } : {}),
					...(preview?.address ? { address: preview.address } : {}),
					...(preview?.countryCode ? { countryCode: preview.countryCode } : {}),
					...(preview?.category && CATEGORIES.has(preview.category)
						? { category: preview.category as never }
						: {}),
					...(preview?.googlePlaceId
						? { googlePlaceId: preview.googlePlaceId }
						: {}),
					...(preview?.osmRef ? { osmRef: preview.osmRef } : {}),
					...(entry.text && kind === "text"
						? { description: entry.text.slice(0, 500) }
						: {}),
				};
				const r = plan.create.length
					? await createNodePath({
							data: {
								tripId: trip.id,
								chain: [
									...(plan.parentId ? [{ id: plan.parentId }] : []),
									...plan.create.map((c) => ({ type: c.type, name: c.name })),
									leaf,
								],
								ids: [...plan.create.map(() => newId()), leafId],
							},
						})
					: await createNode({
							data: {
								tripId: trip.id,
								id: leafId,
								parentId: plan.parentId,
								...leaf,
							},
						});
				suggested = isProposed(r);
				nodeId = leafId;
			}
			// The idea is saved either way; a link or upload that fails is said so.
			let partial: string | null = null;
			if (!asTodo && nodeId && url)
				try {
					const r = await addLink({
						data: { tripId: trip.id, target: { kind: "node", nodeId }, url },
					});
					if (isProposed(r)) suggested = true;
				} catch {
					partial = "The link couldn't be attached — add it from the place.";
				}
			if (!asTodo && nodeId && entry.files.length && canUpload)
				try {
					await uploadFiles(trip.id, nodeId, entry.files);
				} catch (e) {
					partial = humanError(e);
				}
			await deleteShared(entry.id).catch(() => {});
			await Promise.all([
				qc.invalidateQueries({ queryKey: tripKeys.graph(trip.id) }),
				qc.invalidateQueries({ queryKey: meKeys.trips }),
			]);
			const into =
				target.kind === "existing"
					? (places.find((p) => p.id === target.nodeId)?.name ?? "the place")
					: plan.create.length
						? `${plan.create.at(-1)?.name} ideas`
						: plan.parentId
							? `${nodes.find((n) => n.id === plan.parentId)?.name ?? trip.name} ideas`
							: `${trip.name} ideas`;
			setState({
				kind: "done",
				text: suggested
					? `Suggested to ${trip.name}`
					: asTodo
						? `Added to ${trip.name} to-dos`
						: `Saved to ${into}`,
				slug: trip.slug,
				...(nodeId && !suggested ? { sel: `n.${nodeId}` } : {}),
				...(partial ? { note: partial } : {}),
			});
		} catch (e) {
			setState({ kind: "error", text: humanError(e) });
		}
	};

	if (state.kind === "done")
		return (
			<div
				data-testid={HOME_TESTID.shareSaved}
				className="grid justify-items-center gap-4 rounded-2xl border bg-card px-6 py-10 text-center"
			>
				<span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
					<Check className="size-5" />
				</span>
				<p className="font-display text-[17px] font-medium">{state.text}</p>
				{state.note ? (
					<p className="-mt-2 text-[13px] text-muted-foreground">
						{state.note}
					</p>
				) : null}
				<div className="flex gap-2">
					<Button asChild variant="outline">
						<Link
							to="/t/$trip"
							params={{ trip: state.slug }}
							search={(state.sel ? { sel: state.sel } : {}) as never}
						>
							Open in trip
						</Link>
					</Button>
					<Button
						data-testid={HOME_TESTID.shareDone}
						onClick={() => {
							window.close();
							setTimeout(() => window.location.assign("/"), 150);
						}}
					>
						Done
					</Button>
				</div>
			</div>
		);

	if (!trips.isPending && !options.length)
		return (
			<EmptyState
				line="No trip to save to yet."
				action={
					<Button asChild>
						<Link to="/">Go to your trips</Link>
					</Button>
				}
			/>
		);

	const busy = state.kind === "saving";
	const resolving = resolved.isFetching && !found;
	return (
		<form
			className="grid gap-5 rounded-2xl border bg-card p-5 sm:p-6"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<div className="flex items-start gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
					<K.icon className="size-4" />
				</span>
				<div className="grid min-w-0 gap-0.5">
					<span className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
						{K.label}
					</span>
					<span className="truncate text-sm">
						{preview?.name ??
							hint?.name ??
							(url
								? hostOf(url)
								: entry.files.length
									? `${entry.files.length} ${entry.files.length === 1 ? "file" : "files"}`
									: (entry.text ?? "").slice(0, 120))}
					</span>
					{preview?.address ? (
						<span className="truncate text-[12px] text-muted-foreground">
							{preview.address}
						</span>
					) : url ? (
						<span className="truncate font-mono text-[11px] text-muted-foreground">
							{url}
						</span>
					) : null}
				</div>
				{resolving ? (
					<Spinner className="ml-auto size-4 shrink-0 text-muted-foreground" />
				) : null}
			</div>
			{entry.files.length ? (
				<div className="flex gap-2 overflow-x-auto">
					{entry.files.slice(0, 6).map((f) => (
						<FileThumb key={`${f.name}-${f.size}`} file={f} />
					))}
				</div>
			) : null}
			<div className="grid gap-2">
				<Label htmlFor="share-trip">Trip</Label>
				<Select value={tripId ?? ""} onValueChange={setTripId}>
					<SelectTrigger
						id="share-trip"
						className="w-full"
						data-testid={HOME_TESTID.shareTrip}
					>
						<SelectValue placeholder="Choose a trip" />
					</SelectTrigger>
					<SelectContent>
						{options.map((t) => (
							<SelectItem key={t.id} value={t.id}>
								{t.name}
								{t.role === "suggester" ? (
									<span className="text-xs text-muted-foreground">
										{" "}
										· suggest
									</span>
								) : null}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{duplicate ? (
				<div
					data-testid={HOME_TESTID.shareDuplicate}
					className="rounded-lg bg-muted/60 p-3 text-[13px]"
				>
					Already in {trip?.name}:{" "}
					<span className="font-medium">{duplicate.name}</span>
					{found?.existing?.where ? (
						<span className="text-muted-foreground">
							{" "}
							({found.existing.where})
						</span>
					) : null}
				</div>
			) : unresolved ? (
				<p className="rounded-lg bg-muted/60 p-3 text-[13px]">
					Couldn't find that place — save it as a link, or pick where it goes.
				</p>
			) : null}
			<fieldset className="grid gap-2">
				<legend className="mb-2 text-sm font-medium">Where</legend>
				<div className="grid grid-cols-2 gap-2">
					<WhereButton
						active={where.kind === "new"}
						onClick={() => setWhere({ kind: "new" })}
						icon={<Lightbulb className="size-4" />}
						label="New idea"
						hint={`in ${planLabel.split(" › ").at(-1)}`}
					/>
					<WhereButton
						active={where.kind === "existing"}
						onClick={() =>
							setWhere({
								kind: "existing",
								nodeId: duplicate?.id ?? places[0]?.id ?? "",
							})
						}
						icon={<MapPin className="size-4" />}
						label="Add to existing"
						hint="a place in the trip"
					/>
				</div>
			</fieldset>
			{where.kind === "new" ? (
				<div className="grid gap-2">
					<Label htmlFor="share-name">Name</Label>
					<Input
						id="share-name"
						autoFocus
						value={name}
						maxLength={60}
						onChange={(e) => {
							setNameTouched(true);
							setName(e.target.value);
						}}
						data-testid={HOME_TESTID.shareName}
					/>
					<ParentPicker
						nodes={nodes}
						plan={plan}
						label={planLabel}
						onPick={setPicked}
					/>
				</div>
			) : (
				<div className="grid gap-2">
					<Label htmlFor="share-place">Place</Label>
					<Select
						value={where.nodeId}
						onValueChange={(v) => setWhere({ kind: "existing", nodeId: v })}
					>
						<SelectTrigger id="share-place" className="w-full">
							<SelectValue placeholder="Choose a place" />
						</SelectTrigger>
						<SelectContent className="max-h-72">
							{[...places]
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((p) => (
									<SelectItem key={p.id} value={p.id}>
										{p.name}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
				</div>
			)}
			{entry.files.length && !canUpload ? (
				<p className="text-[13px] text-muted-foreground">
					Photos need edit access. Ask the owner, or share a link instead.
				</p>
			) : trip?.role === "suggester" ? (
				<p className="text-[13px] text-muted-foreground">
					You can suggest on this trip: an editor reviews it first.
				</p>
			) : null}
			{offline ? (
				<p className="text-[13px] text-muted-foreground">
					You're offline — it's kept on this device. Open Yonder later to
					finish.
				</p>
			) : null}
			{state.kind === "error" ? (
				<p className="text-[13px] text-destructive" role="alert">
					{state.text}
				</p>
			) : null}
			<div className="flex flex-wrap items-center justify-end gap-2">
				{kind === "text" && where.kind === "new" ? (
					<Button
						type="button"
						variant="ghost"
						data-testid={HOME_TESTID.shareTodo}
						disabled={!trip || offline || busy}
						onClick={() => void save("todo")}
					>
						Add as to-do
					</Button>
				) : null}
				{duplicate && where.kind === "existing" ? (
					<Button
						type="button"
						variant="ghost"
						disabled={!trip || offline || busy}
						onClick={() => void save("new")}
					>
						Save as new idea
					</Button>
				) : null}
				<Button
					type="submit"
					data-testid={HOME_TESTID.shareSave}
					disabled={
						!trip ||
						offline ||
						busy ||
						(where.kind === "existing" && !where.nodeId) ||
						(entry.files.length > 0 && !canUpload)
					}
				>
					{busy ? <Spinner /> : null}
					{duplicate && where.kind === "existing" ? "Add link there" : "Save"}
				</Button>
			</div>
		</form>
	);
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url.slice(0, 80);
	}
}

function WhereButton({
	active,
	onClick,
	icon,
	label,
	hint,
}: {
	active: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	hint: string;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={cn(
				"grid gap-0.5 rounded-lg border p-3 text-left transition-colors",
				active
					? "border-primary bg-primary/5 ring-1 ring-primary"
					: "hover:border-foreground/20",
			)}
		>
			<span className="flex items-center gap-2 text-sm font-medium">
				{icon}
				{label}
			</span>
			<span className="truncate text-xs text-muted-foreground">{hint}</span>
		</button>
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
}: {
	/** The IndexedDB entry id from `/share?id=`. */
	id?: string;
	/** `/share?lost=1`: the POST reached the server instead of the SW. */
	lost?: boolean;
}) {
	const [entry, setEntry] = useState<SharedEntry | null>(null);
	const [loading, setLoading] = useState(!!id);
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
				<h1 className="pt-2 font-display text-[22px] leading-7 font-semibold tracking-[-0.01em]">
					Save to Yonder
				</h1>
				{loading ? (
					<div className="h-64 animate-pulse rounded-2xl bg-muted" />
				) : entry ? (
					<Saver entry={entry} />
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
					</div>
				)}
			</div>
		</Shell>
	);
}
