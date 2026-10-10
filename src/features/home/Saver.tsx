/**
 * The save controls of Save to Yonder (EXTENSIONS §10), shared by the share
 * page (`ShareInbox`) and Saved's feed: saves with ONE tap on the defaults —
 * the trip that has the place (else the last one used), a cleaned name, "New
 * idea" filed where the place belongs. Maps links go through WP-Places'
 * `resolveSharedLink` (short links, place ids, the filing suggestion and
 * `existing`), else `parseMapsUrl` (name and coordinates → the nearest
 * city). "Add to existing" puts the link (or the photos) on a place already
 * in the trip; a duplicate ("Already in Asia 2027: Itoya (Ginza)") makes "Add
 * link there" the primary action and "Save as new idea" the secondary one.
 *
 * Suggesters' ideas become suggestions (the link chains onto the proposed
 * place through its client-chosen id); photos need edit access; viewers and
 * raters never see a trip here.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	Check,
	ChevronRight,
	ChevronsUpDown,
	FolderTree,
	Lightbulb,
	MapPin,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { TypeGlyph } from "@/components/common/glyphs";
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
import { deleteShared, type SharedEntry } from "@/features/offline/share-store";
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
import { cn } from "@/lib/utils";
import { myTripsQuery } from "./queries";
import {
	autoParent,
	classifyShare,
	cleanShareName,
	defaultTrip,
	firstUrl,
	metres,
	normName,
	type ParentPlan,
	parentLabel,
	parseMapsUrl,
	readResolution,
} from "./share-classify";
import { HOME_TESTID } from "./testids";
import type { MyTrip } from "./types";

export const LAST_TRIP = "yonder:share-last-trip";

/** Trips I can add to: members who edit or suggest, and edit/suggest links (never view or rate). */
export function writable(t: MyTrip): boolean {
	return roleAtLeast(t.role, "suggester");
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
					className="inline-flex max-w-full items-center gap-1.5 justify-self-start rounded-full border bg-background px-2.5 text-meta leading-7 transition-colors hover:border-foreground/20"
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

const NONE: readonly string[] = [];

/** What a save did: for Saved's feed (it marks the link added and moves on). */
export type SaveResult = {
	tripId: string;
	tripName: string;
	slug: string;
	/** The new or existing place it went on (null: a to-do, or a suggestion). */
	nodeId: string | null;
	/** "Saved to Kyoto ideas", "Suggested to Japan 2027". */
	text: string;
};

/**
 * The save controls: trip, New idea (named, filed with the area chip) or Add
 * to existing, the duplicate check, then Save. `page` (the share page) is a
 * card of its own with what was shared on top and a "Saved" card after;
 * `feed` (Saved's feed) is just the controls, `actions` beside Save, and
 * `onSaved` takes over after.
 */
export function Saver({
	entry,
	place = null,
	nearTrips = NONE,
	media,
	actions,
	onSaved,
}: {
	entry: SharedEntry;
	/** Where it is, when Saved's preview knows (a Maps place). */
	place?: { name: string; lat: number; lng: number } | null;
	/** The trips that have that place (Saved's picks), for the default. */
	nearTrips?: readonly string[];
	/** Photos and videos (Saved's): how many, and how they go onto the place (edit access). */
	media?: {
		count: number;
		attach: (tripId: string, nodeId: string) => Promise<unknown>;
	};
	/** Feed: more buttons at Save's side (Delete, Later). */
	actions?: React.ReactNode;
	onSaved?: (r: SaveResult) => void;
}) {
	const trips = useQuery(myTripsQuery());
	const qc = useQueryClient();
	const options = (trips.data ?? []).filter(writable);
	const kind = media ? "media" : classifyShare(entry);
	const url = entry.url ?? firstUrl(entry.text);
	const hint = useMemo(
		() => (kind === "maps" && url ? parseMapsUrl(url) : null),
		[kind, url],
	);
	const spot =
		hint?.lat != null && hint.lng != null
			? { lat: hint.lat, lng: hint.lng }
			: place
				? { lat: place.lat, lng: place.lng }
				: null;
	const [tripId, setTripId] = useState<string | null>(null);
	useEffect(() => {
		if (tripId || !options.length) return;
		let last: string | null = null;
		try {
			last = localStorage.getItem(LAST_TRIP);
		} catch {
			last = null;
		}
		setTripId(
			defaultTrip(options, { near: nearTrips, at: spot, last })?.id ?? null,
		);
	}, [options, tripId, nearTrips, spot]);
	const trip = options.find((t) => t.id === tripId) ?? null;
	const graph = useQuery({
		...tripGraphQuery(tripId ?? ""),
		enabled: !!tripId,
	});
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
		() => hint?.name ?? place?.name ?? cleanShareName(entry.title, entry.text),
	);
	const [nameTouched, setNameTouched] = useState(false);
	useEffect(() => {
		if (preview?.name && !nameTouched) setName(preview.name.slice(0, 60));
	}, [preview?.name, nameTouched]);
	const at = preview !== null ? { lat: preview.lat, lng: preview.lng } : spot;
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
			if (!asTodo && nodeId && media && canUpload)
				try {
					await media.attach(trip.id, nodeId);
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
			const text = suggested
				? `Suggested to ${trip.name}`
				: asTodo
					? `Added to ${trip.name} to-dos`
					: `Saved to ${into}`;
			setState({
				kind: "done",
				text,
				slug: trip.slug,
				...(nodeId && !suggested ? { sel: `n.${nodeId}` } : {}),
				...(partial ? { note: partial } : {}),
			});
			onSaved?.({
				tripId: trip.id,
				tripName: trip.name,
				slug: trip.slug,
				nodeId: asTodo || suggested ? null : nodeId,
				text,
			});
		} catch (e) {
			setState({ kind: "error", text: humanError(e) });
		}
	};

	if (state.kind === "done")
		return (
			<div
				data-testid={HOME_TESTID.shareSaved}
				className="flex items-center gap-3 rounded-xl bg-muted/60 p-3"
			>
				<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
					<Check className="size-4" />
				</span>
				<span className="min-w-0 flex-1 text-sm">
					<span className="block font-medium">{state.text}</span>
					{state.note ? (
						<span className="block text-meta text-muted-foreground">
							{state.note}
						</span>
					) : null}
				</span>
				<Button asChild variant="outline" size="sm">
					<Link
						to="/t/$trip"
						params={{ trip: state.slug }}
						search={(state.sel ? { sel: state.sel } : {}) as never}
					>
						Open in trip
					</Link>
				</Button>
			</div>
		);

	if (!trips.isPending && !options.length)
		return (
			<EmptyState
				line="No trip to save to yet."
				action={
					<Button asChild>
						<Link to="/dashboard">Go to your trips</Link>
					</Button>
				}
			/>
		);

	const busy = state.kind === "saving";
	return (
		<form
			className="grid gap-5"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<div className="grid gap-2">
				<Label htmlFor={`share-trip-${entry.id}`}>Trip</Label>
				<Select value={tripId ?? ""} onValueChange={setTripId}>
					<SelectTrigger
						id={`share-trip-${entry.id}`}
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
					className="rounded-lg bg-muted/60 p-3 text-meta"
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
				<p className="rounded-lg bg-muted/60 p-3 text-meta">
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
					<Label htmlFor={`share-name-${entry.id}`}>Name</Label>
					<Input
						id={`share-name-${entry.id}`}
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
					<Label htmlFor={`share-place-${entry.id}`}>Place</Label>
					<Select
						value={where.nodeId}
						onValueChange={(v) => setWhere({ kind: "existing", nodeId: v })}
					>
						<SelectTrigger id={`share-place-${entry.id}`} className="w-full">
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
			{media && !canUpload ? (
				<p className="text-meta text-muted-foreground">
					Photos need edit access. Ask the owner, or share a link instead.
				</p>
			) : trip?.role === "suggester" ? (
				<p className="text-meta text-muted-foreground">
					You can suggest on this trip: an editor reviews it first.
				</p>
			) : null}
			{offline ? (
				<p className="text-meta text-muted-foreground">
					You're offline. It's kept on this device and goes to Saved when you're
					back online.
				</p>
			) : null}
			{state.kind === "error" ? (
				<p className="text-meta text-destructive" role="alert">
					{state.text}
				</p>
			) : null}
			<div className="flex flex-wrap items-center justify-end gap-2">
				{actions ? <div className="mr-auto flex gap-1">{actions}</div> : null}
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
						(!!media && !canUpload)
					}
				>
					{busy ? <Spinner /> : null}
					{duplicate && where.kind === "existing" ? "Add link there" : "Save"}
				</Button>
			</div>
		</form>
	);
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
					? "border-primary bg-accent/50 ring-1 ring-primary"
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
