/**
 * Small pieces of the leg editor: the "Open in Google Maps" link (ADDENDUM
 * §5: on every Japan transit row), the N02 attribution (JAPAN_TRANSIT §5),
 * masked booking values for link guests (DESIGN §4.4), section labels and
 * the proportional segment strip (DESIGN §8.2).
 */
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Lock, UserPlus } from "lucide-react";
import { useState } from "react";
import { useAddPerson } from "@/components/common/member";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TransitRoute } from "@/lib/schemas/legs";
import {
	normalizePersonName,
	PLACEHOLDER_NAME_MAX,
} from "@/lib/schemas/people";
import { cn } from "@/lib/utils";
import {
	googleMapsDirectionsUrl,
	type LegEnds,
	type MapsTravelMode,
} from "../lib/endpoints";
import { segmentStrip } from "../lib/route-view";
import { railInfoQuery } from "../queries";
import { TRANSIT_TESTID } from "../testids";

const MODE_WORD: Record<MapsTravelMode, string> = {
	transit: "transit",
	walking: "walking",
	driving: "driving",
	bicycling: "cycling",
};

/**
 * "Open in Google Maps" (ADDENDUM §5; FB-03). `compact` rows show the short
 * "Google Maps ↗" (the accessible name stays "Open in Google Maps");
 * `iconOnly` is for the tightest rows. `mode` is the directions' travel mode
 * (transit by default); the tooltip names it ("Walking directions in
 * Google Maps").
 */
export function GoogleMapsLink({
	ends,
	href,
	mode = "transit",
	label = "Open in Google Maps",
	compact,
	iconOnly,
	className,
}: {
	ends?: Pick<LegEnds, "from" | "to">;
	href?: string | null;
	mode?: MapsTravelMode;
	label?: string;
	compact?: boolean;
	iconOnly?: boolean;
	className?: string;
}) {
	const url =
		href ??
		(ends?.from && ends.to
			? googleMapsDirectionsUrl(ends.from, ends.to, mode)
			: null);
	if (!url) return null;
	const short = compact || iconOnly;
	const word = MODE_WORD[mode];
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			data-testid={TRANSIT_TESTID.googleMapsLink}
			data-travelmode={mode}
			onClick={(e) => e.stopPropagation()}
			title={`${word[0]?.toUpperCase()}${word.slice(1)} directions in Google Maps`}
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-medium whitespace-nowrap text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
				className,
			)}
			aria-label={short ? label : undefined}
		>
			{iconOnly ? null : <span>{compact ? "Google Maps" : label}</span>}
			<ExternalLink className="size-3" strokeWidth={1.75} aria-hidden />
		</a>
	);
}

/** JAPAN_TRANSIT §5: under estimate routes. Read from the data manifest. */
export function RailAttribution({ className }: { className?: string }) {
	const { data } = useQuery(railInfoQuery());
	const text =
		data?.attributionEn ??
		"Rail network processed from MLIT National Land Numerical Information (Railway, N02-25), CC BY 4.0";
	return (
		<p
			data-testid={TRANSIT_TESTID.railAttribution}
			className={cn("text-2xs leading-4 text-muted-foreground", className)}
		>
			<span lang="ja">
				{data?.attributionJa ??
					"「国土数値情報（鉄道データ）」（国土交通省）を加工して作成"}
			</span>{" "}
			·{" "}
			<a
				href={
					data?.datasetPage ??
					"https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html"
				}
				target="_blank"
				rel="noopener noreferrer"
				className="underline-offset-2 hover:underline"
			>
				{text}
			</a>
			{data?.namesSource ? ` · ${data.namesSource}` : null}
		</p>
	);
}

/** "••" with a lock for link guests (booking refs, seats, costs, points, fees). */
export function Masked({ className }: { className?: string }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					data-testid={TRANSIT_TESTID.masked}
					className={cn(
						"inline-flex items-center gap-1 font-mono text-xs text-muted-foreground",
						className,
					)}
				>
					••
					<Lock className="size-3" strokeWidth={1.75} aria-hidden />
				</span>
			</TooltipTrigger>
			<TooltipContent>Hidden for link guests</TooltipContent>
		</Tooltip>
	);
}

/** The 8px strip: segments proportional to time, walking at 40% "other". */
export function SegmentStrip({
	route,
	dashed,
	className,
}: {
	route: TransitRoute;
	/** Estimates are drawn dashed (DESIGN §1.6 "honest estimates"). */
	dashed?: boolean;
	className?: string;
}) {
	const parts = segmentStrip(route);
	if (!parts.length) return null;
	return (
		<div
			className={cn(
				"flex h-2 w-full gap-px overflow-hidden rounded-full",
				className,
			)}
			role="img"
			aria-label={parts.map((p) => p.label).join(", ")}
		>
			{parts.map((p) => (
				<span
					key={p.key}
					title={p.label}
					className={cn(
						"h-full min-w-1",
						p.walk && "bg-mode-other/40",
						!p.walk && !p.color && "bg-mode-transit",
						dashed && !p.walk && "opacity-75",
					)}
					style={{
						flexGrow: p.share,
						flexBasis: 0,
						...(p.color ? { backgroundColor: p.color } : {}),
					}}
				/>
			))}
		</div>
	);
}

/**
 * ADDENDUM §8 free-text people under a seat list: typing a name that isn't on
 * the trip yet adds a placeholder person, whose seat row then appears. Hidden
 * for people who can't add people (viewers, link guests).
 */
export function AddPersonRow({ disabled }: { disabled?: boolean }) {
	const add = useAddPerson();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	if (!add) return null;
	const typed = normalizePersonName(name);
	const submit = async () => {
		if (!typed || typed.length > PLACEHOLDER_NAME_MAX || busy) return;
		setBusy(true);
		try {
			await add(typed);
			setName("");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex items-center gap-2">
			<UserPlus
				className="size-4 shrink-0 text-muted-foreground"
				strokeWidth={1.5}
				aria-hidden
			/>
			<Input
				data-testid={TRANSIT_TESTID.addPerson}
				aria-label="Add a person"
				placeholder="Add a person…"
				value={name}
				maxLength={PLACEHOLDER_NAME_MAX}
				disabled={disabled || busy}
				onChange={(e) => setName(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void submit();
					}
				}}
				onBlur={() => void submit()}
				className="min-w-0 flex-1 border-dashed"
			/>
		</div>
	);
}
