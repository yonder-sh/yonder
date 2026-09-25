/**
 * The node's time zone with an editor's override (QA TZ-08): the server
 * derives a node's zone from its coordinates (or it inherits its parent's);
 * an editor can pick another IANA zone, or go back to "Automatic". A plain
 * button that opens a searchable list; disabled with the reason when the
 * person can't edit (DESIGN: never hide disabled controls).
 */
import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
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
import type { GraphIndex } from "@/lib/engine/graph-index";
import { addDays, daysBetween, zonedEpoch } from "@/lib/engine/time";
import type { GraphNode } from "@/lib/engine/types";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useUpdateNode } from "../mutations";
import { PLACES_TESTID } from "../testids";

/** Every IANA zone the runtime knows (a short fallback on old engines). */
export function timeZoneNames(): string[] {
	const intl = Intl as unknown as {
		supportedValuesOf?: (key: "timeZone") => string[];
	};
	try {
		const all = intl.supportedValuesOf?.("timeZone");
		if (all?.length) return all.includes("UTC") ? all : [...all, "UTC"];
	} catch {
		// fall through
	}
	return [
		"UTC",
		"Asia/Tokyo",
		"Asia/Seoul",
		"Asia/Taipei",
		"Asia/Ho_Chi_Minh",
		"Europe/Istanbul",
		"America/New_York",
	];
}

/**
 * "GMT+9" for a zone at an instant. `at` is required (FB-20): pass the
 * moment that matters (the trip's dates), never "now" by default.
 */
export function offsetLabel(tz: string, at: number | Date): string {
	try {
		return (
			new Intl.DateTimeFormat("en-US", {
				timeZone: tz,
				timeZoneName: "shortOffset",
			})
				.formatToParts(at)
				.find((p) => p.type === "timeZoneName")?.value ?? ""
		);
	} catch {
		return "";
	}
}

/**
 * The zone's offset over the trip's dates (FB-20): "GMT+9", or both when it
 * changes during the trip, with the local date of the change ("GMT-4 →
 * GMT-5 from Nov 7"). Dates are "YYYY-MM-DD"; offsets are read at local noon.
 */
export function tripOffsetLabel(tz: string, from: string, to: string): string {
	let at: (date: string) => number;
	try {
		at = (date) => zonedEpoch(date, "12:00", tz);
		at(from);
	} catch {
		return "";
	}
	const a = offsetLabel(tz, at(from));
	const b = offsetLabel(tz, at(to));
	if (a === b || to <= from) return a;
	// The first date with the end's offset (clocks change once per season).
	let lo = 0;
	let hi = daysBetween(from, to);
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (offsetLabel(tz, at(addDays(from, mid))) === a) lo = mid;
		else hi = mid;
	}
	return `${a} → ${b} from ${formatShortDate(addDays(from, hi))}`;
}

/** "Nov 7". */
const formatShortDate = (date: string) =>
	new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});

export function ZonePicker({ node }: { node: GraphNode }) {
	const { ix, graph } = useWorkspace();
	const guard = useEditGuard();
	const update = useUpdateNode(graph.trip.id);
	const [open, setOpen] = useState(false);
	const zone = ix.tzOf(node.id);
	const zones = useMemo(() => (open ? timeZoneNames() : []), [open]);
	// FB-20: offsets for the trip's dates (else the node's first scheduled
	// day, else today), both when a zone changes during the trip.
	const [from, to] = tripSpan(ix, node.id);
	const offsets = useMemo(
		() => new Map(zones.map((z) => [z, tripOffsetLabel(z, from, to)])),
		[zones, from, to],
	);
	const pick = (tz: string | null) => {
		setOpen(false);
		if (tz === node.tz) return;
		update.mutate({ nodeId: node.id, patch: { tz } });
	};
	const zoneHint = open ? null : tripOffsetLabel(zone, from, to);
	const auto =
		node.lat !== null && node.lng !== null
			? "Automatic (from the location)"
			: `Automatic (same as ${ix.node(node.parentId)?.name ?? "the trip"})`;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<EditGuard>
				<PopoverTrigger asChild>
					<Button
						size="xs"
						variant="ghost"
						disabled={guard.disabled}
						data-testid={PLACES_TESTID.tzPicker}
						aria-label={`Time zone: ${zone}. Change the time zone`}
						className="-ml-1.5 h-6 gap-1 px-1.5 font-normal text-muted-foreground"
					>
						{zone}
						{zoneHint ? (
							<span
								data-testid={PLACES_TESTID.tzOffsets}
								className="font-mono text-[11px] tnum"
							>
								{zoneHint}
							</span>
						) : null}
						<ChevronDown className="size-3" />
					</Button>
				</PopoverTrigger>
			</EditGuard>
			<PopoverContent align="start" className="w-72 p-0">
				<Command>
					<CommandInput placeholder="Search time zones…" />
					<CommandList className="max-h-72">
						<CommandEmpty>No time zone matches.</CommandEmpty>
						<CommandGroup>
							<CommandItem value="automatic" onSelect={() => pick(null)}>
								<span className="truncate">{auto}</span>
							</CommandItem>
						</CommandGroup>
						<CommandGroup heading="Time zones">
							{zones.map((z) => (
								<CommandItem
									key={z}
									value={`${z} ${offsets.get(z) ?? ""}`}
									onSelect={() => pick(z)}
								>
									{z === zone ? (
										<Check className="size-3.5" />
									) : (
										<span className="size-3.5" aria-hidden="true" />
									)}
									{/* A zone that changes during the trip reads its two offsets
									    on a line of their own, so the name keeps its room. */}
									<span className="min-w-0 flex-1">
										<span className="block truncate">
											{z.replace(/_/g, " ")}
										</span>
										{offsets.get(z)?.includes("→") ? (
											<span className="block font-mono text-[11px] tnum text-muted-foreground">
												{offsets.get(z)}
											</span>
										) : null}
									</span>
									{offsets.get(z)?.includes("→") ? null : (
										<span className="font-mono text-xs tnum text-muted-foreground">
											{offsets.get(z)}
										</span>
									)}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/**
 * The dates a zone label should hold for (FB-20): the trip's start and end,
 * else the node's scheduled days, else today.
 */
export function tripSpan(ix: GraphIndex, nodeId: string): [string, string] {
	const { startDate, endDate } = ix.trip;
	if (startDate) return [startDate, endDate ?? startDate];
	const dates = ix.located
		.filter((it) => it.nodeId && ix.isWithin(it.nodeId, nodeId))
		.map((it) => ix.day(it.dayId)?.date)
		.filter((d): d is string => !!d);
	if (dates.length) return [dates[0] as string, dates.at(-1) as string];
	const today = new Date().toISOString().slice(0, 10);
	return [today, today];
}
