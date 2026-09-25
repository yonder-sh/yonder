/**
 * The public landing page (`/`): a dark "space" hero with the demo trip
 * drawing itself on a globe (the in-app Overview's look), then one section
 * per part of the app, each with real screenshots of the invented showcase
 * trip (`shots.ts`). The hero stays dark in both themes, as the Overview's
 * does; the sections follow the theme and swap their screenshots with it.
 *
 * Server-rendered and script-free to look at: the globe animates with CSS,
 * images are lazy below the fold, and nothing here needs hydration to work.
 */
import "./landing.css";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
	ArrowRight,
	Eye,
	FileText,
	ListChecks,
	type LucideIcon,
	MessageSquarePlus,
	MousePointer2,
	NotebookPen,
	Users,
	Wallet,
	WifiOff,
} from "lucide-react";
import { type CSSProperties, Fragment, type ReactNode } from "react";
import { PRIORITIES, PRIORITY_ORDER } from "@/lib/domain/taxonomy";
import { YonderLockup } from "@/routes/(auth)/-components/yonder-lockup";
import {
	countryOf,
	DEMO_COUNTRIES,
	DEMO_HOME,
	DEMO_STAYS,
	DEMO_TRIP,
	type DemoCountry,
	type DemoStay,
} from "./demo-route";
import { LandingGlobe } from "./globe/LandingGlobe";
import { buildScene, DRAW_DELAY_MS, DRAW_MS } from "./globe/scene";
import { GITHUB_URL, SUPPORT_EMAIL } from "./meta";
import { SHOTS, type Shot, type ShotTheme, shotSrc } from "./shots";

const SIGN_IN = "/login";
const CONTAINER = "mx-auto w-full max-w-[1200px] px-5 sm:px-8";

/** One accent per part of the app: the demo route's country colours, in order. */
const ACCENT = {
	places: DEMO_COUNTRIES[0]?.color ?? "#ff7a6b",
	plan: DEMO_COUNTRIES[1]?.color ?? "#6fb4ff",
	overview: DEMO_COUNTRIES[2]?.color ?? "#f5c046",
	together: DEMO_COUNTRIES[3]?.color ?? "#56d6a8",
} as const;

export function LandingPage() {
	return (
		<div className="min-h-svh bg-background text-foreground">
			<a
				href="#main"
				className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow"
			>
				Skip to content
			</a>
			<Hero />
			<main id="main">
				<DecideTogether />
				<EveryDay />
				<AtAGlance />
				<LiveTogether />
				<TheRest />
				<Closing />
			</main>
			<Footer />
		</div>
	);
}

// ---- hero ---------------------------------------------------------------------

function Hero() {
	return (
		<div
			className="dark relative isolate overflow-hidden bg-[#040507] text-white"
			style={{
				backgroundImage:
					"radial-gradient(ellipse 60% 70% at 72% 46%, rgb(28 40 64 / .55), transparent 70%), radial-gradient(ellipse 50% 45% at 8% 0%, rgb(73 79 167 / .22), transparent 70%)",
			}}
		>
			<header
				className={cn(
					CONTAINER,
					"flex h-16 items-center justify-between sm:h-20",
				)}
			>
				<Link to="/" aria-label="Yonder" className="rounded-md">
					<YonderLockup className="h-7 sm:h-8" />
				</Link>
				<nav aria-label="Account">
					<Link
						to={SIGN_IN}
						className="rounded-full px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/8 hover:text-white"
					>
						Sign in
					</Link>
				</nav>
			</header>
			<section
				aria-labelledby="hero-title"
				className={cn(
					CONTAINER,
					"grid grid-cols-1 items-center gap-2 pt-6 pb-4 sm:pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:gap-6 lg:pt-8 lg:pb-6",
				)}
			>
				{/* Above the globe, which reaches up to the button on phones. */}
				<div className="relative z-10 max-w-[34rem]">
					<p
						className="landing-rise font-mono text-[12px] font-medium tracking-[0.14em] text-white/55 uppercase"
						style={{ "--delay": "0ms" } as CSSProperties}
					>
						Collaborative trip planner
					</p>
					<h1
						id="hero-title"
						className="landing-rise mt-5 font-display text-[clamp(3.4rem,9.2vw,7.25rem)] leading-[0.92] font-semibold tracking-[-0.045em] text-balance"
						style={{ "--delay": "60ms" } as CSSProperties}
					>
						Plan trips together.
					</h1>
					<p
						className="landing-rise mt-6 max-w-[30rem] text-[1.1875rem] leading-[1.5] text-pretty text-white/70 sm:text-xl"
						style={{ "--delay": "160ms" } as CSSProperties}
					>
						One shared plan for the whole group: places, days, flights and
						money, updating live.
					</p>
					<div
						className="landing-rise mt-9 flex flex-wrap items-center gap-3"
						style={{ "--delay": "260ms" } as CSSProperties}
					>
						<PrimaryCta />
					</div>
				</div>
				<div className="relative -mx-5 sm:mx-auto sm:w-[min(100%,40rem)] lg:mx-0 lg:-my-10 lg:w-auto">
					<LandingGlobe />
				</div>
			</section>
			{/* The planet sets behind the strip. */}
			<div className="relative bg-linear-to-b from-transparent via-[#040507]/85 via-35% to-[#040507] pt-10">
				<div className={cn(CONTAINER, "pb-10 sm:pb-14")}>
					<RouteStrip />
				</div>
			</div>
		</div>
	);
}

function PrimaryCta({ className }: { className?: string }) {
	return (
		<Link
			to={SIGN_IN}
			className={cn(
				"group inline-flex h-12 items-center gap-2 rounded-full bg-glow px-6 text-[15px] font-semibold text-glow-foreground shadow-[0_0_0_1px_rgb(248_176_93/.35),0_12px_40px_-12px_rgb(248_176_93/.7)] transition-[filter,box-shadow] hover:brightness-105 hover:shadow-[0_0_0_1px_rgb(248_176_93/.5),0_14px_48px_-10px_rgb(248_176_93/.85)] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-glow",
				className,
			)}
		>
			Start planning today
			<ArrowRight
				aria-hidden="true"
				className="size-4 transition-transform group-hover:translate-x-0.5"
			/>
		</Link>
	);
}

/** When each stay's dot appears on the globe (the strip fills in with it). */
const STAY_AT = new Map(buildScene().dots.map((d) => [d.id, d.at]));

/**
 * The demo trip as the Overview's route strip: from New York, every stay
 * sized by its nights, grouped by country, and home. Phones get it as a
 * vertical route instead (`RouteList`).
 */
function RouteStrip() {
	const groups = DEMO_COUNTRIES.map((c) => ({
		country: c,
		stays: DEMO_STAYS.filter((s) => s.country === c.key),
	})).map((g) => ({
		...g,
		nights: g.stays.reduce((n, s) => n + s.nights, 0),
	}));
	return (
		<figure className="border-t border-white/10 pt-5">
			<figcaption className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 font-mono text-[11.5px] tracking-[0.06em] text-white/50 uppercase">
				<span>Example trip · {DEMO_TRIP.name}</span>
				<span>
					{DEMO_TRIP.nights} nights · {DEMO_TRIP.countries} countries ·{" "}
					{DEMO_TRIP.cities} cities
				</span>
			</figcaption>
			<RouteList groups={groups} />
			<ol className="hidden gap-3 sm:flex">
				<HomeEnd label="From" />
				{groups.map((g) => (
					<li
						key={g.country.key}
						className="min-w-0 grow-(--nights) basis-0"
						style={{ "--nights": g.nights } as CSSProperties}
					>
						<p className="truncate font-mono text-[11px] tracking-[0.08em] text-white/55 uppercase">
							{g.country.name}
						</p>
						<ol className="mt-2 flex gap-1">
							{g.stays.map((s) => (
								<li
									key={s.id}
									className="min-w-0"
									style={{ flexGrow: s.nights, flexBasis: 0 }}
								>
									<span
										className="lg-pop block h-1.5 rounded-full"
										style={
											{
												background: countryOf(s.country).color,
												"--delay": `${Math.round(DRAW_DELAY_MS + (STAY_AT.get(s.id) ?? 1) * DRAW_MS - 80)}ms`,
											} as CSSProperties
										}
									/>
									<span className="mt-2 block truncate text-[13.5px] font-medium text-white/85">
										{s.name}
									</span>
									<span className="block font-mono text-[11px] text-white/55">
										{s.nights} nights
									</span>
								</li>
							))}
						</ol>
					</li>
				))}
				<HomeEnd label="Home" />
			</ol>
		</figure>
	);
}

type RouteGroup = {
	country: DemoCountry;
	stays: DemoStay[];
	nights: number;
};

/** The route list's connector down to the next row (the flights are dashed). */
function Connector() {
	return (
		<span
			aria-hidden="true"
			className="absolute top-[1.4rem] bottom-0.5 left-[calc(0.375rem-0.5px)] border-l border-dashed border-white/25"
		/>
	);
}

/** New York at either end of the route list: a ring, as it has no nights. */
function HomeRow({ label, last = false }: { label: string; last?: boolean }) {
	return (
		<li className="relative grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-baseline gap-x-3.5 pb-5 last:pb-0">
			{last ? null : <Connector />}
			<span
				aria-hidden="true"
				className="size-3 self-center rounded-full border-2 border-white/45"
			/>
			<p className="truncate text-[15px] font-medium text-white/90">
				{DEMO_HOME.name}
			</p>
			<p className="font-mono text-[11px] text-white/55">{label}</p>
		</li>
	);
}

/**
 * Phones: the route top to bottom, from New York and back, a country a stop
 * (its cities in order under it), joined by the flights as on the globe.
 */
function RouteList({ groups }: { groups: readonly RouteGroup[] }) {
	return (
		<ol className="sm:hidden">
			<HomeRow label="Start" />
			{groups.map((g) => (
				<li
					key={g.country.key}
					className="relative grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-baseline gap-x-3.5 pb-5"
				>
					<Connector />
					<span
						aria-hidden="true"
						className="lg-pop size-3 self-center rounded-full"
						style={
							{
								background: g.country.color,
								boxShadow: `0 0 0 4px ${g.country.color}2e`,
								"--delay": `${Math.round(DRAW_DELAY_MS + (STAY_AT.get(g.stays[0]?.id ?? "") ?? 1) * DRAW_MS - 80)}ms`,
							} as CSSProperties
						}
					/>
					<p className="truncate text-[15px] font-medium text-white/90">
						{g.country.name}
					</p>
					<p className="font-mono text-[11px] text-white/55 tnum">
						{g.nights} nights
					</p>
					<p className="col-start-2 col-end-4 mt-0.5 text-[13px] text-white/55">
						{g.stays.map((s, j) => (
							<Fragment key={s.id}>
								{j ? (
									<span aria-hidden="true" className="px-1.5 text-white/30">
										→
									</span>
								) : null}
								{s.name}
							</Fragment>
						))}
					</p>
				</li>
			))}
			<HomeRow label="Home" last />
		</ol>
	);
}

/** The strip's ends: New York, reached by a (dashed) flight. */
function HomeEnd({ label }: { label: string }) {
	return (
		<li className="w-24 shrink-0">
			<p className="truncate font-mono text-[11px] tracking-[0.08em] text-white/55 uppercase">
				{label}
			</p>
			<span aria-hidden="true" className="mt-2 flex h-1.5 items-center">
				<span className="w-full border-t border-dashed border-white/35" />
			</span>
			<span className="mt-2 block truncate text-[13.5px] font-medium text-white/85">
				{DEMO_HOME.name}
			</span>
			<span className="block font-mono text-[11px] text-white/55">Flight</span>
		</li>
	);
}

// ---- sections -------------------------------------------------------------------

function Eyebrow({ color, children }: { color: string; children: ReactNode }) {
	return (
		<p className="flex items-center gap-2.5 font-mono text-[12px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
			<span
				aria-hidden="true"
				className="size-2 rounded-full"
				style={{ background: color, boxShadow: `0 0 0 4px ${color}26` }}
			/>
			{children}
		</p>
	);
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
	return (
		<h2
			id={id}
			className="mt-4 font-display text-[clamp(2.25rem,4.6vw,3.6rem)] leading-[1.02] font-semibold tracking-[-0.035em] text-balance"
		>
			{children}
		</h2>
	);
}

function Lede({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<p
			className={cn(
				"mt-5 max-w-[32rem] text-lg leading-[1.6] text-pretty text-muted-foreground",
				className,
			)}
		>
			{children}
		</p>
	);
}

function DecideTogether() {
	return (
		<section
			aria-labelledby="decide-title"
			className="overflow-x-clip py-24 sm:py-32"
		>
			<div
				className={cn(
					CONTAINER,
					"grid grid-cols-1 items-center gap-14 lg:grid-cols-[minmax(0,4.4fr)_minmax(0,7.6fr)] lg:gap-14",
				)}
			>
				<div>
					<Eyebrow color={ACCENT.places}>Places</Eyebrow>
					<SectionTitle id="decide-title">Decide together</SectionTitle>
					<Lede>
						Everyone rates the ideas in a feed made for swiping, one place at a
						time. The group's favourites rise into a shortlist, so the plan
						starts from what you all want to do.
					</Lede>
					<RatingScale />
				</div>
				<div className="relative pb-[12%] lg:-mr-[7vw]">
					<div className="ml-[21%]">
						<BrowserFrame url="yonder.sh/t/east-asia · Places">
							<ThemedShot
								shot={SHOTS.places}
								sizes="(min-width: 1024px) 720px, 76vw"
							/>
						</BrowserFrame>
					</div>
					<PhoneFrame className="absolute bottom-0 left-0 w-[25%] min-w-[104px]">
						<ThemedShot
							shot={SHOTS.rate}
							sizes="(min-width: 1024px) 220px, 26vw"
						/>
					</PhoneFrame>
				</div>
			</div>
		</section>
	);
}

/** The six ratings, in the app's colours (Palette D). */
function RatingScale() {
	return (
		<ul aria-label="The ratings" className="mt-8 flex flex-wrap gap-1.5">
			{PRIORITY_ORDER.map((p) => {
				const t = PRIORITIES[p];
				return (
					<li
						key={p}
						className="rounded-full px-3 py-1 text-[13px] font-medium [background:var(--l-bg)] [color:var(--l-fg)] dark:[background:var(--d-bg)] dark:[color:var(--d-fg)]"
						style={
							{
								"--l-bg": t.light.bg,
								"--l-fg": t.light.fg,
								"--d-bg": t.dark.bg,
								"--d-fg": t.dark.fg,
							} as CSSProperties
						}
					>
						{t.label}
					</li>
				);
			})}
		</ul>
	);
}

function EveryDay() {
	return (
		<section
			aria-labelledby="plan-title"
			className="border-y bg-[color-mix(in_oklch,var(--primary)_4%,var(--background))] py-24 sm:py-32"
		>
			<div className={CONTAINER}>
				<div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-16">
					<div>
						<Eyebrow color={ACCENT.plan}>Plan</Eyebrow>
						<SectionTitle id="plan-title">Every day, planned</SectionTitle>
					</div>
					<Lede className="lg:mb-1">
						A day-by-day timeline with real travel times between the stops,
						flights that land in the right time zone, and a live map of the day
						right beside it.
					</Lede>
				</div>
				<div className="relative mt-14 pr-[12%] sm:mt-16 lg:pr-[16%]">
					<BrowserFrame url="yonder.sh/t/east-asia · Plan">
						<ThemedShot
							shot={SHOTS.plan}
							sizes="(min-width: 1200px) 960px, 88vw"
						/>
					</BrowserFrame>
					<PhoneFrame className="absolute right-0 -bottom-8 w-[27%] min-w-[124px] sm:-bottom-12">
						<ThemedShot
							shot={SHOTS.flight}
							sizes="(min-width: 1200px) 300px, 27vw"
						/>
					</PhoneFrame>
				</div>
			</div>
		</section>
	);
}

function AtAGlance() {
	return (
		<section
			aria-labelledby="glance-title"
			className="dark relative isolate overflow-hidden bg-[#040507] py-24 text-white sm:py-32"
			style={{
				backgroundImage:
					"radial-gradient(ellipse 55% 60% at 70% 50%, rgb(28 40 64 / .5), transparent 70%)",
			}}
		>
			<div
				className={cn(
					CONTAINER,
					"grid grid-cols-1 items-center gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16",
				)}
			>
				<div>
					<Eyebrow color={ACCENT.overview}>Overview</Eyebrow>
					<SectionTitle id="glance-title">
						The whole trip at a glance
					</SectionTitle>
					<Lede>
						The route on a globe, the countdown, what's still to book and every
						day in order, on one page. Share cards turn it into a picture for
						your story or the group chat.
					</Lede>
				</div>
				<div className="relative pr-[22%] pb-6 sm:pr-[24%]">
					<BrowserFrame url="yonder.sh/t/east-asia · Overview" dark>
						<Picture
							shot={SHOTS.overview}
							theme="dark"
							sizes="(min-width: 1024px) 560px, 76vw"
						/>
					</BrowserFrame>
					<figure className="absolute right-0 bottom-0 w-[34%] min-w-[112px]">
						<div className="overflow-hidden rounded-[14px] shadow-[0_30px_60px_-20px_rgb(0_0_0/.8),0_0_0_1px_rgb(255_255_255/.1)]">
							<Picture
								shot={SHOTS.card}
								theme="dark"
								sizes="(min-width: 1024px) 220px, 34vw"
							/>
						</div>
						<figcaption className="mt-3 text-center font-mono text-[11px] tracking-[0.08em] text-white/50 uppercase">
							Share card
						</figcaption>
					</figure>
				</div>
			</div>
		</section>
	);
}

const TOGETHER: { icon: LucideIcon; title: string; body: string }[] = [
	{
		icon: Users,
		title: "Presence",
		body: "Faces in the top bar show who's in the trip right now.",
	},
	{
		icon: MousePointer2,
		title: "Live cursors",
		body: "Watch pointers move, and say something right where you're looking.",
	},
	{
		icon: Eye,
		title: "Follow",
		body: "Click a face to see what they see while you talk it through.",
	},
	{
		icon: MessageSquarePlus,
		title: "Suggestions",
		body: "Friends can suggest changes; you review them before they land.",
	},
];

function LiveTogether() {
	return (
		<section
			aria-labelledby="live-title"
			className="overflow-x-clip py-24 sm:py-32"
		>
			<div
				className={cn(
					CONTAINER,
					"grid grid-cols-1 items-center gap-14 lg:grid-cols-[minmax(0,7.4fr)_minmax(0,4.6fr)] lg:gap-14",
				)}
			>
				<div className="lg:order-2">
					<Eyebrow color={ACCENT.together}>Together</Eyebrow>
					<SectionTitle id="live-title">Live, together</SectionTitle>
					<Lede>
						Plan on a call or on your own time. Changes show up for everyone as
						they're made, and you can always see who else is there.
					</Lede>
					<ul className="mt-9 grid gap-x-8 gap-y-6 sm:grid-cols-2">
						{TOGETHER.map(({ icon: Icon, title, body }) => (
							<li key={title}>
								<p className="flex items-center gap-2 text-[15px] font-semibold">
									<Icon aria-hidden="true" className="size-4 text-primary" />
									{title}
								</p>
								<p className="mt-1.5 text-[15px] leading-[1.55] text-muted-foreground">
									{body}
								</p>
							</li>
						))}
					</ul>
				</div>
				<div className="lg:order-1 lg:-ml-[7vw]">
					<BrowserFrame url="yonder.sh/t/east-asia · Plan">
						<ThemedShot
							shot={SHOTS.live}
							sizes="(min-width: 1024px) 820px, 90vw"
						/>
					</BrowserFrame>
				</div>
			</div>
		</section>
	);
}

const REST: {
	icon: LucideIcon;
	title: string;
	body: string;
	shot: Shot;
	span: string;
	phone?: boolean;
}[] = [
	{
		icon: FileText,
		title: "Photos and PDFs",
		body: "Tickets, confirmations and the photos you took, kept next to the places they belong to.",
		shot: SHOTS.media,
		span: "md:col-span-3",
	},
	{
		icon: Wallet,
		title: "Shared expenses and budgets",
		body: "Log what you spend in any currency, split it fairly and see who owes whom. Set budgets by country or category.",
		shot: SHOTS.money,
		span: "md:col-span-3",
	},
	{
		icon: ListChecks,
		title: "Lists and to-dos",
		body: "Packing and shopping lists, and to-dos that know when bookings open.",
		shot: SHOTS.lists,
		span: "md:col-span-2",
	},
	{
		icon: NotebookPen,
		title: "Notes",
		body: "Notes for the trip, a city or a single day, written together in real time.",
		shot: SHOTS.notes,
		span: "md:col-span-2",
	},
	{
		icon: WifiOff,
		title: "Works offline, as an app",
		body: "Install it on your phone. The last trip you opened stays readable without a signal.",
		shot: SHOTS.offline,
		span: "md:col-span-2",
		phone: true,
	},
];

function TheRest() {
	return (
		<section
			aria-labelledby="rest-title"
			className="border-t bg-[color-mix(in_oklch,var(--primary)_4%,var(--background))] py-24 sm:py-32"
		>
			<div className={CONTAINER}>
				<h2
					id="rest-title"
					className="max-w-[40rem] font-display text-[clamp(2rem,3.8vw,3rem)] leading-[1.05] font-semibold tracking-[-0.03em] text-balance"
				>
					Everything else, in the same place
				</h2>
				<ul className="mt-12 grid gap-4 md:grid-cols-6">
					{REST.map(({ icon: Icon, title, body, shot, span, phone }) => (
						<li
							key={title}
							className={cn(
								"flex flex-col overflow-hidden rounded-3xl border bg-card",
								span,
							)}
						>
							<div className="p-6 pb-5">
								<h3 className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.01em]">
									<Icon
										aria-hidden="true"
										className="size-[18px] text-primary"
									/>
									{title}
								</h3>
								<p className="mt-2 text-[15px] leading-[1.55] text-muted-foreground">
									{body}
								</p>
							</div>
							<div
								className={cn(
									"relative mt-auto overflow-hidden bg-[color-mix(in_oklch,var(--primary)_6%,var(--background))]",
									phone
										? "aspect-[4/3] px-10 pt-6 md:aspect-auto md:h-[15rem]"
										: "aspect-[16/10] pt-5 pl-5 md:aspect-auto md:h-[15rem]",
								)}
							>
								{phone ? (
									<PhoneFrame className="mx-auto w-[58%] max-w-[180px]">
										<ThemedShot shot={shot} sizes="180px" />
									</PhoneFrame>
								) : (
									<div className="h-full overflow-hidden rounded-tl-xl border-t border-l bg-background shadow-[0_10px_30px_-12px_rgb(24_29_47/.25)]">
										<ThemedShot
											shot={shot}
											sizes="(min-width: 768px) 560px, 92vw"
											fill
										/>
									</div>
								)}
							</div>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}

function Closing() {
	return (
		<section
			aria-labelledby="closing-title"
			className="dark relative isolate overflow-hidden bg-[#040507] py-24 text-center text-white sm:py-32"
			style={{
				backgroundImage:
					"radial-gradient(ellipse 50% 80% at 50% 110%, rgb(73 79 167 / .35), transparent 70%)",
			}}
		>
			<div className={CONTAINER}>
				<h2
					id="closing-title"
					className="font-display text-[clamp(2.75rem,6.5vw,5rem)] leading-[1] font-semibold tracking-[-0.04em]"
				>
					Where to next?
				</h2>
				<p className="mx-auto mt-5 max-w-[30rem] text-lg leading-[1.6] text-pretty text-white/65">
					Start a trip, invite the people you're going with, and plan it
					together.
				</p>
				<div className="mt-9 flex justify-center">
					<PrimaryCta />
				</div>
			</div>
		</section>
	);
}

function Footer() {
	return (
		<footer className="border-t bg-background">
			<div
				className={cn(
					CONTAINER,
					"flex flex-col gap-8 py-12 text-sm text-muted-foreground md:flex-row md:items-start md:justify-between",
				)}
			>
				<div className="space-y-3">
					<YonderLockup className="h-6" />
					<p>© {new Date().getFullYear()} Yonder</p>
				</div>
				<nav
					aria-label="Footer"
					className="grid gap-x-12 gap-y-6 sm:grid-cols-2"
				>
					<div>
						<p className="font-mono text-[11px] tracking-[0.12em] text-foreground/70 uppercase">
							Support
						</p>
						<p className="mt-2">
							<a
								href={`mailto:${SUPPORT_EMAIL}`}
								className="text-foreground underline-offset-4 hover:underline"
							>
								{SUPPORT_EMAIL}
							</a>
						</p>
					</div>
					<div>
						<p className="font-mono text-[11px] tracking-[0.12em] text-foreground/70 uppercase">
							Source
						</p>
						<p className="mt-2">
							<a
								href={GITHUB_URL}
								className="text-foreground underline-offset-4 hover:underline"
								rel="noopener"
							>
								GitHub
							</a>
						</p>
					</div>
				</nav>
			</div>
		</footer>
	);
}

// ---- frames and screenshots ---------------------------------------------------

function BrowserFrame({
	url,
	dark,
	children,
}: {
	url: string;
	dark?: boolean;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-[14px] border bg-card shadow-[0_1px_2px_rgb(24_29_47/.06),0_24px_60px_-24px_rgb(24_29_47/.35)] dark:shadow-[0_1px_2px_rgb(0_0_0/.4),0_30px_70px_-24px_rgb(0_0_0/.8)]",
				dark && "border-white/10 bg-[#0a0a0a]",
			)}
		>
			<div
				aria-hidden="true"
				className={cn(
					"flex h-8 items-center gap-3 border-b px-3.5",
					dark ? "border-white/10 bg-[#111214]" : "bg-muted/60",
				)}
			>
				<span className="flex gap-1.5">
					<i className="size-2.5 rounded-full bg-foreground/15" />
					<i className="size-2.5 rounded-full bg-foreground/15" />
					<i className="size-2.5 rounded-full bg-foreground/15" />
				</span>
				<span className="mx-auto min-w-0 max-w-[60%] truncate rounded-md bg-background/70 px-3 py-0.5 font-mono text-[10.5px] text-muted-foreground">
					{url}
				</span>
				<span className="w-[42px]" />
			</div>
			{children}
		</div>
	);
}

function PhoneFrame({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"rounded-[15%/6.9%] bg-[#0b0c10] p-[1.4%] shadow-[0_0_0_1px_rgb(255_255_255/.08)_inset,0_30px_60px_-18px_rgb(24_29_47/.5),0_0_0_1px_rgb(24_29_47/.12)] dark:shadow-[0_0_0_1px_rgb(255_255_255/.1)_inset,0_30px_60px_-18px_rgb(0_0_0/.85)]",
				className,
			)}
		>
			<div className="relative overflow-hidden rounded-[13.6%/6.3%]">
				{children}
			</div>
		</div>
	);
}

/** Both theme variants; CSS shows the one that matches (lazy: only it loads). */
function ThemedShot({
	shot,
	sizes,
	fill,
}: {
	shot: Shot;
	sizes: string;
	/** Cover the box from the top-left corner (the grid's crops). */
	fill?: boolean;
}) {
	if (shot.themes.length < 2)
		return (
			<Picture
				shot={shot}
				theme={shot.themes[0] ?? "light"}
				sizes={sizes}
				fill={fill}
			/>
		);
	return (
		<>
			<Picture
				shot={shot}
				theme="light"
				sizes={sizes}
				fill={fill}
				className="dark:hidden"
			/>
			<Picture
				shot={shot}
				theme="dark"
				sizes={sizes}
				fill={fill}
				className="hidden dark:block"
			/>
		</>
	);
}

function Picture({
	shot,
	theme,
	sizes,
	fill,
	className,
}: {
	shot: Shot;
	theme: ShotTheme;
	sizes: string;
	fill?: boolean;
	/** On the <picture> (visibility). */
	className?: string;
}) {
	const srcSet = (ext: "avif" | "webp") =>
		shot.half
			? `${shotSrc(shot, theme, ext, true)} ${shot.width / 2}w, ${shotSrc(shot, theme, ext)} ${shot.width}w`
			: `${shotSrc(shot, theme, ext)} ${shot.width}w`;
	return (
		<picture className={cn("block", fill && "h-full", className)}>
			<source type="image/avif" srcSet={srcSet("avif")} sizes={sizes} />
			<source type="image/webp" srcSet={srcSet("webp")} sizes={sizes} />
			<img
				src={shotSrc(shot, theme, "webp")}
				alt={shot.alt}
				width={shot.width}
				height={shot.height}
				loading="lazy"
				decoding="async"
				className={cn(
					"block w-full",
					fill ? "h-full object-cover object-[left_top]" : "h-auto",
				)}
			/>
		</picture>
	);
}
