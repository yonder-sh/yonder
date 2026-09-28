/**
 * The Where picker (One Yonder, D13): one button in the top bar says where
 * you are ("Japan › Tokyo") and opens the trip's places: the whole trip,
 * then countries › regions › cities › areas with their dates and who's
 * there; typing finds any place too. It replaces the breadcrumb, the level
 * switch and the Outline popover. Its foot opens the place's details
 * ("About Tokyo") and Organize places (the tree, to rename, move, reorder).
 */
import { ChevronDown, MapPin, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { formatDateRange } from "@/lib/format";
import { TESTID } from "@/lib/testids";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CrumbPresence } from "./cursors/presence-ui";
import { OrganizePlaces } from "./OrganizePlaces";
import { SHELL_TESTID } from "./testids";
import { wherePlaces, whereRows } from "./where-rows";

export function WherePicker({
	className,
	short = false,
}: {
	className?: string;
	/** Just the place's name ("Tokyo"; the phone's header), not its path. */
	short?: boolean;
}) {
	const { ix, scope, nav, graph } = useWorkspace();
	const [open, setOpen] = useState(false);
	const [organize, setOrganize] = useState(false);
	const [q, setQ] = useState("");
	const rows = useMemo(() => (open ? whereRows(ix) : []), [open, ix]);
	const places = useMemo(
		() => (open && q.trim() ? wherePlaces(ix) : []),
		[open, q, ix],
	);
	const label = scope
		? short
			? scope.name
			: ix
					.path(scope.id)
					.slice(-2)
					.map((n) => n.name)
					.join(" › ")
		: "Whole trip";
	const close = () => {
		setOpen(false);
		setQ("");
	};
	return (
		<>
			<Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						data-testid={SHELL_TESTID.whereButton}
						// Others see the picker (anchored here) while it's open.
						data-cursor-anchor="pane:where"
						aria-label={`Where: ${label}. Choose a place`}
						className={cn("min-w-0 gap-1.5 px-2 font-medium", className)}
					>
						<MapPin className="text-muted-foreground" />
						<span className="truncate">{label}</span>
						<CrumbPresence nodeId={scope?.id ?? null} />
						<ChevronDown className="text-muted-foreground" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="w-80 p-0"
					data-testid={SHELL_TESTID.wherePicker}
				>
					<Command>
						<CommandInput
							placeholder="Find a city, area or place"
							value={q}
							onValueChange={setQ}
						/>
						<CommandList className="max-h-[min(60vh,28rem)]">
							<CommandEmpty>Nothing called that in this trip.</CommandEmpty>
							<CommandGroup>
								{rows.map((r) => {
									const current = (scope?.id ?? null) === r.id;
									return (
										<CommandItem
											key={r.id ?? "trip"}
											value={`${r.name} ${r.path} ${r.id ?? "trip"}`}
											onSelect={() => {
												close();
												if (!current) nav.zoomTo(r.id);
											}}
											data-testid={SHELL_TESTID.whereRow}
											data-node-id={r.id ?? ""}
											data-current={current || undefined}
											aria-current={current ? "location" : undefined}
											style={
												q.trim()
													? undefined
													: {
															paddingLeft: `${0.5 + Math.max(0, r.depth - 1) * 0.875}rem`,
														}
											}
											className={cn(current && "font-semibold")}
										>
											<span className="truncate">{r.name}</span>
											<CrumbPresence nodeId={r.id} />
											<span className="ml-auto shrink-0 text-xs text-muted-foreground tnum">
												{r.dates}
											</span>
										</CommandItem>
									);
								})}
							</CommandGroup>
							{places.length ? (
								<CommandGroup heading="Places">
									{places.map((p) => (
										<CommandItem
											key={p.id}
											value={`${p.name} ${p.path} ${p.id}`}
											onSelect={() => {
												close();
												const node = ix.node(p.id);
												nav.zoomTo(node?.parentId ?? null, {
													sel: { kind: "node", id: p.id as string },
												});
											}}
											data-testid={SHELL_TESTID.whereRow}
											data-node-id={p.id ?? ""}
										>
											<span className="truncate">{p.name}</span>
											<span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
												{p.path}
											</span>
										</CommandItem>
									))}
								</CommandGroup>
							) : null}
						</CommandList>
					</Command>
					<div className="flex items-center gap-1 border-t p-1">
						<Button
							variant="ghost"
							size="sm"
							data-testid={SHELL_TESTID.whereAbout}
							className="min-w-0"
							onClick={() => {
								close();
								nav.select(
									scope ? { kind: "node", id: scope.id } : { kind: "root" },
								);
							}}
						>
							<span className="truncate">
								About {scope?.name ?? graph.trip.name}
							</span>
						</Button>
						<Button
							variant="ghost"
							size="sm"
							data-testid={SHELL_TESTID.whereOrganize}
							className="ml-auto shrink-0"
							onClick={() => {
								close();
								setOrganize(true);
							}}
						>
							Organize places
						</Button>
					</div>
				</PopoverContent>
			</Popover>
			<OrganizePlaces open={organize} onOpenChange={setOrganize} />
		</>
	);
}

/** The day range the Plan is narrowed to ("5–7 Oct ✕"). */
export function DayRangeChip() {
	const { days, nav } = useWorkspace();
	if (!days) return null;
	return (
		<span
			data-testid={TESTID.dayRangeChip}
			className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-muted pr-1 pl-2 text-meta tnum"
		>
			{formatDateRange(days.from, days.to)}
			<button
				type="button"
				onClick={() => nav.setDays(null)}
				aria-label="Show all days"
				className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
			>
				<X className="size-3" />
			</button>
		</span>
	);
}
