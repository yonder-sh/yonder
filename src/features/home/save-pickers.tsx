/**
 * Where a saved thing goes: the area a new idea is filed in, or the place it's
 * added to. Both are long lists, so both search, and the places are grouped
 * under their city or area ("Japan › Tokyo › Shibuya") with the ones near the
 * shared spot first. Wide screens get a popover by the field; phones get a
 * full-screen sheet sized to what the keyboard leaves, search on top, and the
 * keyboard only once search is tapped.
 */
import { Check, ChevronsUpDown, FolderTree, MapPin } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { TypeGlyph } from "@/components/common/glyphs";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { canNest } from "@/lib/engine/tree";
import type { GraphNode } from "@/lib/engine/types";
import { cn } from "@/lib/utils";
import { metres, type ParentPlan } from "./share-classify";
import { HOME_TESTID } from "./testids";

/** How far a place may be from the shared spot to be suggested. */
const NEAR_M = 2_000;

/** The part of the screen the keyboard leaves (the visual viewport). */
function useVisibleBox(active: boolean) {
	const [box, setBox] = useState<{ top: number; height: number } | null>(null);
	useEffect(() => {
		const vv = typeof window === "undefined" ? null : window.visualViewport;
		if (!active || !vv) return;
		const on = () => setBox({ top: vv.offsetTop, height: vv.height });
		on();
		vv.addEventListener("resize", on);
		vv.addEventListener("scroll", on);
		return () => {
			vv.removeEventListener("resize", on);
			vv.removeEventListener("scroll", on);
		};
	}, [active]);
	return box;
}

/** A field-like button that opens a searchable list: popover wide, sheet on a phone. */
function PickerField({
	title,
	placeholder,
	trigger,
	children,
	open,
	onOpenChange,
}: {
	title: string;
	placeholder: string;
	trigger: ReactNode;
	children: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const mobile = useIsMobile();
	const box = useVisibleBox(open && mobile);
	const list = (
		<Command
			data-testid={HOME_TESTID.sharePicker}
			// What's typed, not letters scattered through ("sky" isn't "Shinjuku Gyoen").
			filter={(value, search) =>
				value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
			}
			className={cn(mobile && "min-h-0 flex-1 rounded-none")}
		>
			<CommandInput
				placeholder={placeholder}
				className={cn(mobile && "h-11 text-base")}
			/>
			<CommandList
				className={cn(
					mobile
						? "max-h-none flex-1 overscroll-contain [&_[cmdk-item]]:py-2.5"
						: "max-h-[min(55vh,26rem)]",
				)}
			>
				<CommandEmpty>Nothing called that in this trip.</CommandEmpty>
				{children}
			</CommandList>
		</Command>
	);
	if (!mobile)
		return (
			<Popover open={open} onOpenChange={onOpenChange}>
				<PopoverTrigger asChild>{trigger}</PopoverTrigger>
				<PopoverContent
					className="w-(--radix-popover-trigger-width) min-w-72 p-0"
					align="start"
				>
					{list}
				</PopoverContent>
			</Popover>
		);
	return (
		<>
			{trigger}
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent
					// Browse first; the keyboard comes when search is tapped.
					onOpenAutoFocus={(e) => e.preventDefault()}
					className="top-0 left-0 flex max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:max-w-none"
					style={{
						top: box?.top ?? 0,
						height: box ? `${box.height}px` : "100dvh",
					}}
				>
					<DialogTitle className="border-b px-4 py-3 pr-12 text-base">
						{title}
					</DialogTitle>
					{list}
				</DialogContent>
			</Dialog>
		</>
	);
}

/** The button a picker hangs from (a phone opens the sheet itself). */
function FieldButton({
	icon,
	children,
	onClick,
	...rest
}: {
	icon: ReactNode;
	children: ReactNode;
	onClick?: () => void;
	"data-testid": string;
	"aria-label": string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			{...rest}
			className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md border bg-background px-3 text-left text-sm transition-colors hover:border-foreground/20"
		>
			<span className="shrink-0 text-muted-foreground">{icon}</span>
			<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
				{children}
			</span>
			<ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
		</button>
	);
}

type Indexed = {
	byId: Map<string, GraphNode>;
	/** "Japan › Tokyo" for a node's ancestors. */
	pathOf: (id: string) => string;
	/** Depth-first, in the trip's order. */
	outline: GraphNode[];
};

function useIndexed(nodes: readonly GraphNode[]): Indexed {
	return useMemo(() => {
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const kids = new Map<string | null, GraphNode[]>();
		for (const n of nodes) {
			const list = kids.get(n.parentId) ?? [];
			list.push(n);
			kids.set(n.parentId, list);
		}
		const outline: GraphNode[] = [];
		const walk = (pid: string | null) => {
			for (const n of kids.get(pid) ?? []) {
				outline.push(n);
				walk(n.id);
			}
		};
		walk(null);
		const pathOf = (id: string) => {
			const names: string[] = [];
			let cur = byId.get(id)?.parentId;
			for (let guard = 0; cur && guard < 16; guard++) {
				const n = byId.get(cur);
				if (!n) break;
				names.unshift(n.name);
				cur = n.parentId;
			}
			return names.join(" › ");
		};
		return { byId, pathOf, outline };
	}, [nodes]);
}

/** Where a new idea is filed: the top level or any country, region, city or area. */
export function AreaPicker({
	nodes,
	plan,
	suggested,
	label,
	tripName,
	onPick,
}: {
	nodes: readonly GraphNode[];
	plan: ParentPlan;
	/** The automatic plan, when it creates an area ("Rinka-cho (new)"). */
	suggested: ParentPlan;
	label: string;
	tripName: string;
	onPick: (plan: ParentPlan | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const { pathOf, outline } = useIndexed(nodes);
	const areas = outline.filter(
		(n) => canNest(n.type, "place") && n.type !== "place",
	);
	const pick = (p: ParentPlan | null) => {
		onPick(p);
		setOpen(false);
	};
	const is = (id: string | null) => plan.parentId === id && !plan.create.length;
	const newArea = suggested.create.at(-1);
	return (
		<PickerField
			title="File it in"
			placeholder="Find a city or area"
			open={open}
			onOpenChange={setOpen}
			trigger={
				<FieldButton
					icon={<FolderTree className="size-4" />}
					data-testid={HOME_TESTID.shareParent}
					aria-label={`Filed in ${label}. Change`}
					onClick={() => setOpen(true)}
				>
					<span className="truncate">{label}</span>
				</FieldButton>
			}
		>
			{newArea ? (
				<CommandGroup heading="Suggested">
					<CommandItem
						value={`__suggested ${newArea.name}`}
						onSelect={() => pick(null)}
					>
						<FolderTree className="text-muted-foreground" />
						<span className="truncate">{newArea.name}</span>
						<span className="shrink-0 text-xs text-muted-foreground">new</span>
						{plan.create.length ? <Check className="ml-auto size-4" /> : null}
					</CommandItem>
				</CommandGroup>
			) : null}
			<CommandGroup heading={newArea ? "In the trip" : undefined}>
				<CommandItem
					value={`__top ${tripName}`}
					onSelect={() => pick({ parentId: null, create: [] })}
				>
					<span className="flex-1 truncate">Top level · {tripName}</span>
					{is(null) ? <Check className="size-4" /> : null}
				</CommandItem>
				{areas.map((n) => {
					const path = pathOf(n.id);
					return (
						<CommandItem
							key={n.id}
							value={`${n.name} ${n.localName ?? ""} ${path} ${n.id}`}
							onSelect={() => pick({ parentId: n.id, create: [] })}
						>
							<TypeGlyph type={n.type} category={n.category} />
							<span className="truncate">{n.name}</span>
							{path ? (
								<span className="ml-auto min-w-0 shrink truncate pl-2 text-xs text-muted-foreground">
									{path}
								</span>
							) : null}
							{is(n.id) ? <Check className="size-4 shrink-0" /> : null}
						</CommandItem>
					);
				})}
			</CommandGroup>
		</PickerField>
	);
}

/** The place it's added to, grouped by where it is; near ones first. */
export function PlacePicker({
	nodes,
	value,
	at,
	duplicateId,
	onPick,
}: {
	nodes: readonly GraphNode[];
	value: string;
	at: { lat: number; lng: number } | null;
	duplicateId: string | null;
	onPick: (nodeId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const { byId, pathOf, outline } = useIndexed(nodes);
	const { near, groups } = useMemo(() => {
		const targets = outline.filter(
			(n) =>
				(n.type === "place" || n.type === "area") && n.status !== "dropped",
		);
		const near = targets
			.flatMap((n) => {
				if (n.id === duplicateId) return [{ n, m: -1 }];
				if (!at || n.lat == null || n.lng == null) return [];
				const m = metres(at, { lat: n.lat, lng: n.lng });
				return m <= NEAR_M ? [{ n, m }] : [];
			})
			.sort((a, b) => a.m - b.m)
			.slice(0, 5)
			.map((x) => x.n);
		const groups = new Map<string, GraphNode[]>();
		for (const n of targets) {
			const key = n.parentId ?? "";
			const list = groups.get(key) ?? [];
			list.push(n);
			groups.set(key, list);
		}
		return {
			near,
			groups: [...groups].map(([pid, list]) => ({
				pid,
				heading: pid
					? [pathOf(pid), byId.get(pid)?.name].filter(Boolean).join(" › ")
					: "",
				list: list.sort((a, b) => a.name.localeCompare(b.name)),
			})),
		};
	}, [outline, at, duplicateId, pathOf, byId]);
	const chosen = byId.get(value) ?? null;
	const pick = (id: string) => {
		onPick(id);
		setOpen(false);
	};
	const item = (n: GraphNode, key: string, withPath: boolean) => (
		<CommandItem
			key={key}
			value={`${key} ${n.name} ${n.localName ?? ""} ${pathOf(n.id)}`}
			onSelect={() => pick(n.id)}
		>
			<TypeGlyph type={n.type} category={n.category} />
			<span className="truncate">{n.name}</span>
			{withPath ? (
				<span className="ml-auto min-w-0 shrink truncate pl-2 text-xs text-muted-foreground">
					{pathOf(n.id)}
				</span>
			) : null}
			{n.id === value ? <Check className="ml-auto size-4 shrink-0" /> : null}
		</CommandItem>
	);
	return (
		<PickerField
			title="Add to a place"
			placeholder="Find a place"
			open={open}
			onOpenChange={setOpen}
			trigger={
				<FieldButton
					icon={<MapPin className="size-4" />}
					data-testid={HOME_TESTID.sharePlace}
					aria-label={
						chosen ? `Adding to ${chosen.name}. Change` : "Choose a place"
					}
					onClick={() => setOpen(true)}
				>
					{chosen ? (
						<>
							<span className="truncate font-medium">{chosen.name}</span>
							<span className="min-w-0 truncate text-xs text-muted-foreground">
								{pathOf(chosen.id).split(" › ").slice(-2).join(" › ")}
							</span>
						</>
					) : (
						<span className="text-muted-foreground">Choose a place</span>
					)}
				</FieldButton>
			}
		>
			{near.length ? (
				<CommandGroup heading={at ? "Nearby" : "Same name"}>
					{near.map((n) => item(n, `near-${n.id}`, true))}
				</CommandGroup>
			) : null}
			{groups.map((g) => (
				<CommandGroup key={g.pid || "top"} heading={g.heading || "Top level"}>
					{g.list.map((n) => item(n, n.id, false))}
				</CommandGroup>
			))}
		</PickerField>
	);
}
