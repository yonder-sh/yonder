import { createFileRoute, notFound } from "@tanstack/react-router";
import { CalendarDays, Check, Clock, Plus, Search, Share2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	Chip,
	type ChipTone,
	EmptyState,
	Eyebrow,
	HereBadge,
	LiveAvatar,
	RatingButtons,
	RatingDot,
	RatingMenu,
	RatingPill,
	Section,
	Segmented,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PRIORITY_ORDER } from "@/lib/domain/taxonomy";
import type { Priority } from "@/lib/schemas/enums";

/**
 * `/dev/kit`: the One Yonder kit in light and dark, side by side, for review
 * and screenshots. Dev builds only (404 otherwise); no backend.
 */
export const Route = createFileRoute("/dev/kit")({
	ssr: false,
	beforeLoad: () => {
		if (!import.meta.env.DEV) throw notFound();
	},
	head: () => ({ meta: [{ title: "Kit · Yonder" }] }),
	component: KitGallery,
});

const AUDREY = { name: "Audrey Lin", color: 1 };
const MAYA = { name: "Maya Chen", color: 3 };
const KAI = { name: "Kai Viewer", color: 2 };
const TONES: ChipTone[] = [
	"neutral",
	"outline",
	"selected",
	"accent",
	"good",
	"warn",
	"now",
	"danger",
];

function Block({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="grid gap-3">
			<Eyebrow>{title}</Eyebrow>
			{children}
		</div>
	);
}

function Kit() {
	const [view, setView] = useState<"days" | "cities">("days");
	const [rating, setRating] = useState<Priority | null>("really_want");
	return (
		<div className="grid gap-8 p-8">
			<Block title="Type">
				<div className="grid gap-1.5">
					<p className="font-display text-5xl font-bold tracking-tight">
						Asia 2027
					</p>
					<p className="font-display text-2xl font-semibold">
						Nakano + Shinjuku
					</p>
					<p className="text-lg font-semibold">Where things stand</p>
					<p className="text-body">
						Cha no Ikedaya · matcha soft serve (body, 15)
					</p>
					<p className="text-sm">Buttons, rows and menus (14)</p>
					<p className="text-meta text-muted-foreground">
						Food & drink · 30 min · Shinjuku (meta, 13)
					</p>
					<p className="text-xs text-muted-foreground">
						Captions and chips (12)
					</p>
					<p className="text-sm tnum">
						09:30 · ¥9,000 · $33.33 (numbers, body font)
					</p>
				</div>
			</Block>
			<Block title="Buttons">
				<div className="grid gap-2">
					{(["default", "outline", "ghost", "destructive"] as const).map(
						(v) => (
							<div key={v} className="flex flex-wrap items-center gap-2">
								{(["sm", "default", "lg", "xl"] as const).map((s) => (
									<Button key={s} variant={v} size={s}>
										<Plus /> {v === "default" ? "Add to day" : "Directions"}
									</Button>
								))}
								<Button variant={v} size="icon" aria-label="Search">
									<Search />
								</Button>
							</div>
						),
					)}
				</div>
			</Block>
			<Block title="Fields">
				<div className="flex flex-wrap items-center gap-2">
					<Input placeholder="What for" className="w-56" />
					<Select defaultValue="usd">
						<SelectTrigger className="w-32">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="usd">USD</SelectItem>
							<SelectItem value="jpy">JPY</SelectItem>
						</SelectContent>
					</Select>
					<Segmented
						label="View"
						value={view}
						onValueChange={setView}
						options={[
							{ value: "days", label: "Days" },
							{ value: "cities", label: "Cities & nights" },
						]}
					/>
					<Tabs defaultValue="todo">
						<TabsList>
							<TabsTrigger value="todo">To-dos</TabsTrigger>
							<TabsTrigger value="bookings">Bookings</TabsTrigger>
						</TabsList>
					</Tabs>
				</div>
			</Block>
			<Block title="Chips">
				{(["sm", "md", "lg"] as const).map((s) => (
					<div key={s} className="flex flex-wrap items-center gap-2">
						{TONES.map((t) => (
							<Chip
								key={t}
								tone={t}
								size={s}
								icon={
									t === "good"
										? Check
										: t === "now"
											? Clock
											: t === "accent"
												? CalendarDays
												: undefined
								}
							>
								{t}
							</Chip>
						))}
					</div>
				))}
			</Block>
			<Block title="Ratings">
				<div className="flex flex-wrap items-center gap-2">
					{PRIORITY_ORDER.map((p) => (
						<RatingPill key={p} level={p} />
					))}
					<RatingPill level={null} />
				</div>
				<div className="flex flex-wrap items-center gap-3">
					{PRIORITY_ORDER.map((p) => (
						<RatingDot key={p} level={p} />
					))}
				</div>
				<RatingButtons value={rating} onRate={setRating} />
				<RatingButtons value={rating} onRate={setRating} variant="outline" />
				<RatingMenu value={rating} onChange={setRating} label="Your rating" />
			</Block>
			<Block title="Live together">
				<div className="flex flex-wrap items-center gap-3">
					<LiveAvatar user={AUDREY} />
					<LiveAvatar user={MAYA} />
					<LiveAvatar user={KAI} online={false} />
					<HereBadge user={MAYA} />
					<HereBadge user={AUDREY} label="Audrey · just now" />
					<HereBadge user={AUDREY} label="Audrey is typing" />
				</div>
			</Block>
			<div className="rounded-xl border bg-card px-4">
				<Section
					title="Notes"
					divided={false}
					action={
						<Button size="icon-sm" variant="ghost" aria-label="Add a note">
							<Plus />
						</Button>
					}
				>
					<p className="text-body">Matcha soft serve. Get the large cone.</p>
				</Section>
				<Section title="Photos & links">
					<EmptyState line="Add a photo, reel or link" />
				</Section>
			</div>
			<div className="flex items-center gap-2">
				<Button>
					<Share2 /> Share
				</Button>
			</div>
		</div>
	);
}

function KitGallery() {
	return (
		<div className="grid min-h-svh grid-cols-1 xl:grid-cols-2">
			<div className="bg-background text-foreground">
				<Kit />
			</div>
			<div className="dark bg-background text-foreground">
				<Kit />
			</div>
		</div>
	);
}
