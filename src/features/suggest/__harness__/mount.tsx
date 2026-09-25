/**
 * DEV/E2E-ONLY harness (never imported by the app): shows WP-Suggest's UI in
 * the real workspace BEFORE WP-Shell, WP-Lists and WP-Plan mount it, without
 * touching their files. An e2e spec (or a person) loads it into a running
 * `/dev/fixture/…` or `/t/<slug>/…` page:
 *
 *   window.__suggestHarness = { proposals: "fixture" | "live" }
 *   <script type="module" src="/src/features/suggest/__harness__/mount.tsx">
 *
 * It renders ONE extra React root with its own `WorkspaceModelProvider` (the
 * graph from `window.__yonder`, which `VITE_E2E=1` exposes; the same URL) and
 * portals the components into the places the contracts name:
 * - `SuggestModeControl` before Share in the TopBar (after the bell on mobile),
 * - `ProposalBar` above the inspector tabs, `NoteSuggestions` under the notes,
 * - `ReviewDrawer` (global), and `GhostActions` + the dashed ghost look on the
 *   Plan cards of marked items (what `ProposalGhost` will draw).
 * Navigation goes through `history.pushState` + `popstate`, which the app's
 * router follows, so "Show" really selects in the workspace.
 *
 * When a real mount already exists (after integration), that slot is skipped.
 */
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemberAvatar, presenceColor } from "@/components/common/member";
import { leadMark } from "@/components/common/proposal-ghost";
import { TooltipProvider } from "@/components/ui/tooltip";
import { bundleTargetForSel } from "@/features/shell/bundle-target";
import type { TripGraph } from "@/lib/engine/types";
import { demoGraph, N, scenario } from "@/lib/fixtures/demo";
import { makeQueryClient } from "@/lib/query/client";
import { tripGraphQuery, tripProposalsQuery } from "@/lib/query/trip-queries";
import type { ProposalDto } from "@/lib/schemas/proposals";
import {
	WorkspaceModelProvider,
	type WorkspaceRouteBinding,
} from "@/lib/workspace/model-context";
import type { NavTarget } from "@/lib/workspace/nav";
import { WorkspaceSearch } from "@/lib/workspace/search";
import { useProposalMarks } from "@/lib/workspace/use-proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { GhostActions } from "../GhostActions";
import { NoteSuggestions } from "../NoteSuggestions";
import { ProposalBar } from "../ProposalBar";
import { ReviewDrawer } from "../ReviewDrawer";
import { SuggestModeControl } from "../SuggestModeControl";
import { appQueryClient } from "./app-query-client";

type HarnessConfig = { proposals?: "fixture" | "live" };
type Win = Window & {
	__yonder?: { graph: TripGraph };
	__suggestHarness?: HarnessConfig;
	__suggestHarnessMounted?: boolean;
};
const win = window as Win;

/** A note addition on Shibuya Sky, so the notes slot has something to show. */
const NOTE_DEMO: ProposalDto = {
	...(scenario.proposals[0] as ProposalDto),
	id: "00000000-0000-7000-8000-000000005a01",
	op: "note.append",
	entityKind: "note",
	entityId: N.shibuyaSky ?? null,
	createdIds: [],
	summary: "suggested an addition to the notes of Shibuya Sky",
	payload: {
		tripId: demoGraph.trip.id,
		target: { kind: "node", nodeId: N.shibuyaSky ?? "" },
		markdown:
			"**Sunset slots sell out** — book the 17:20 entry four weeks ahead.\n\n- bring a jacket, it's windy up there\n- [tickets](https://www.shibuya-scramble-square.com/sky/ticket/)",
	},
	createdAt: "2026-09-22T10:08:00.000Z",
	updatedAt: "2026-09-22T10:08:00.000Z",
};

function basePath(): { base: string; splat: string } {
	const p = location.pathname;
	const fixture = p.match(/^\/dev\/fixture(?:\/(.*))?$/);
	if (fixture) return { base: "/dev/fixture", splat: fixture[1] ?? "" };
	const live = p.match(/^\/t\/([^/]+)(?:\/(.*))?$/);
	if (live) return { base: `/t/${live[1]}`, splat: live[2] ?? "" };
	return { base: p, splat: "" };
}

function readSearch(): WorkspaceSearch {
	const raw: Record<string, unknown> = {};
	for (const [k, v] of new URLSearchParams(location.search)) {
		try {
			raw[k] = JSON.parse(v);
		} catch {
			raw[k] = v;
		}
	}
	return WorkspaceSearch.safeParse(raw).data ?? {};
}

function hrefOf(t: NavTarget): string {
	const { base } = basePath();
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(t.search))
		if (v !== undefined && v !== null) qs.set(k, String(v));
	const q = qs.toString();
	return `${base}${t.splat ? `/${t.splat}` : ""}${q ? `?${q}` : ""}`;
}

/** A container placed next to an anchor; re-placed when the anchor re-renders. */
function useSlot(
	name: string,
	find: () => Element | null | undefined,
	where: "before" | "after" | "inside",
	skipIf?: () => boolean,
): HTMLElement | null {
	const [el, setEl] = useState<HTMLElement | null>(null);
	useEffect(() => {
		const box = document.createElement("span");
		box.dataset.suggestSlot = name;
		box.style.display = "contents";
		const place = () => {
			if (skipIf?.()) {
				box.remove();
				setEl(null);
				return;
			}
			const anchor = find();
			if (!anchor) {
				box.remove();
				setEl(null);
				return;
			}
			const ok =
				where === "inside"
					? box.parentElement === anchor
					: where === "before"
						? box.nextElementSibling === anchor
						: box.previousElementSibling === anchor;
			if (!ok) {
				if (where === "inside") anchor.appendChild(box);
				else
					anchor.insertAdjacentElement(
						where === "before" ? "beforebegin" : "afterend",
						box,
					);
			}
			setEl(box);
		};
		place();
		const t = window.setInterval(place, 250);
		return () => {
			window.clearInterval(t);
			box.remove();
		};
	}, [name, find, where, skipIf]);
	return el;
}

const byTestId = (id: string, root: ParentNode = document) =>
	root.querySelector(`[data-testid="${id}"]`);

const findTopbar = () => {
	const bar = byTestId("top-bar");
	return bar ? byTestId("share-button", bar) : null;
};
const findPill = () => {
	const pills = byTestId("mobile-pills");
	return pills ? byTestId("inbox-bell", pills) : null;
};
const hasRealControl = () =>
	[...document.querySelectorAll('[data-testid="suggest-mode-control"]')].some(
		(e) => !e.closest("[data-suggest-slot]"),
	);
const findInspectorTabs = () => {
	const lists = [...document.querySelectorAll('[role="tablist"]')];
	const tabs = lists.find(
		(l) =>
			l.textContent?.includes("Overview") && l.textContent.includes("Notes"),
	);
	return tabs?.closest('[data-slot="tabs"]') ?? null;
};
const hasRealBar = () =>
	[...document.querySelectorAll('[data-testid="proposal-bar"]')].some(
		(e) => !e.closest("[data-suggest-slot]"),
	);
const findNotes = () => byTestId("notes-panel");

/**
 * The ghost look on a Plan card, drawn as a fixed overlay over the card (the
 * card may itself be a <button>, so nothing is put inside it). Hover or focus
 * on the card shows the reviewer's ✓/✕, like `ProposalGhost` will.
 */
function GhostCard({ itemId, el }: { itemId: string; el: HTMLElement }) {
	const marks = useProposalMarks(`item:${itemId}`);
	const lead = leadMark(marks);
	const [rect, setRect] = useState<DOMRect | null>(null);
	const [hover, setHover] = useState(false);
	const timer = useRef(0);
	const show = useCallback(() => {
		window.clearTimeout(timer.current);
		setHover(true);
	}, []);
	const hide = useCallback(() => {
		timer.current = window.setTimeout(() => setHover(false), 250);
	}, []);
	useEffect(() => {
		if (!lead) return;
		let raf = 0;
		const tick = () => {
			const r = el.getBoundingClientRect();
			setRect((prev) =>
				prev &&
				prev.top === r.top &&
				prev.left === r.left &&
				prev.width === r.width &&
				prev.height === r.height
					? prev
					: r,
			);
			raf = requestAnimationFrame(tick);
		};
		tick();
		el.addEventListener("mouseenter", show);
		el.addEventListener("mouseleave", hide);
		el.addEventListener("focusin", show);
		el.addEventListener("focusout", hide);
		return () => {
			cancelAnimationFrame(raf);
			el.removeEventListener("mouseenter", show);
			el.removeEventListener("mouseleave", hide);
			el.removeEventListener("focusin", show);
			el.removeEventListener("focusout", hide);
		};
	}, [el, lead, show, hide]);
	if (!lead || !rect || rect.width === 0) return null;
	const color = presenceColor(lead.author.color);
	return (
		<div
			data-suggest-ghost=""
			className="pointer-events-none fixed z-30"
			style={{
				top: rect.top,
				left: rect.left,
				width: rect.width,
				height: rect.height,
				outline: `1.5px dashed ${color}`,
				outlineOffset: "-3px",
				borderRadius: 8,
			}}
		>
			{/* Placed like F's ProposalGhost: the avatar on the corner, ✓/✕ beside it. */}
			<span className="absolute -top-1.5 -right-1">
				<MemberAvatar
					user={{ name: lead.author.name, color: lead.author.color }}
					size={16}
				/>
			</span>
			{hover ? (
				<span
					ref={(node) => {
						if (!node) return;
						node.addEventListener("mouseenter", show);
						node.addEventListener("mouseleave", hide);
						return () => {
							node.removeEventListener("mouseenter", show);
							node.removeEventListener("mouseleave", hide);
						};
					}}
					data-suggest-ghost-actions=""
					className="pointer-events-auto absolute -top-2 right-5 flex gap-1"
				>
					<GhostActions proposalId={lead.proposalId} />
				</span>
			) : null}
		</div>
	);
}

function GhostCards() {
	const { graph, proposals } = useWorkspace();
	const [cards, setCards] = useState<{ id: string; el: HTMLElement }[]>([]);
	useEffect(() => {
		const marked = [...proposals.marks.keys()]
			.filter((k) => k.startsWith("item:"))
			.map((k) => k.slice(5));
		const scan = () => {
			const used = new Set<HTMLElement>();
			const found: { id: string; el: HTMLElement }[] = [];
			const cardsNow = [
				...document.querySelectorAll<HTMLElement>(
					'[data-testid="timeline-item"]',
				),
			].filter((e) => !e.closest("[data-proposed]"));
			for (const id of marked) {
				const it = graph.items.find((i) => i.id === id);
				if (!it?.dayId) continue;
				const name =
					it.title ?? graph.nodes.find((n) => n.id === it.nodeId)?.name;
				const el =
					cardsNow.find((e) => e.dataset.itemId === id) ??
					cardsNow.find(
						(e) =>
							!e.dataset.itemId &&
							!used.has(e) &&
							name &&
							e.textContent?.includes(name),
					);
				if (!el || used.has(el)) continue;
				used.add(el);
				found.push({ id, el });
			}
			setCards((prev) =>
				prev.length === found.length &&
				prev.every((p, i) => p.el === found[i]?.el && p.id === found[i]?.id)
					? prev
					: found,
			);
		};
		scan();
		const t = window.setInterval(scan, 500);
		return () => window.clearInterval(t);
	}, [graph, proposals.marks]);
	return (
		<>
			{cards.map((c) => (
				<GhostCard key={c.id} itemId={c.id} el={c.el} />
			))}
		</>
	);
}

function Slots({ compact }: { compact: boolean }) {
	const { sel, ix } = useWorkspace();
	const topbar = useSlot("topbar", findTopbar, "before", hasRealControl);
	const pill = useSlot("pill", findPill, "after", hasRealControl);
	const bar = useSlot("inspector", findInspectorTabs, "before", hasRealBar);
	const notes = useSlot("notes", findNotes, "after");
	const target = bundleTargetForSel(ix, sel);
	return (
		<>
			{topbar
				? createPortal(<SuggestModeControl compact={compact} />, topbar)
				: null}
			{pill ? createPortal(<SuggestModeControl compact />, pill) : null}
			{bar ? createPortal(<ProposalBar sel={sel} />, bar) : null}
			{notes && target
				? createPortal(<NoteSuggestions target={target} editor={null} />, notes)
				: null}
			<GhostCards />
			<ReviewDrawer />
		</>
	);
}

/**
 * Live mode: the graph and the proposals from the app's own query cache (the
 * same data the app renders), never read back from `window.__yonder` (which
 * this harness's provider overwrites too).
 */
function LiveData({
	tripId,
	fallback,
	children,
}: {
	tripId: string;
	fallback: TripGraph;
	children: (graph: TripGraph, p: ProposalDto[]) => ReactNode;
}) {
	const g = useQuery({ ...tripGraphQuery(tripId) });
	const q = useQuery({ ...tripProposalsQuery(tripId) });
	return <>{children(g.data ?? fallback, q.data ?? [])}</>;
}

function HarnessRoot() {
	const [loc, setLoc] = useState(() => ({
		...basePath(),
		search: readSearch(),
	}));
	// The graph on load; live mode then follows the app's query cache.
	const [graph] = useState<TripGraph | null>(win.__yonder?.graph ?? null);
	const [width, setWidth] = useState(window.innerWidth);
	useEffect(() => {
		const onPop = () => setLoc({ ...basePath(), search: readSearch() });
		const onResize = () => setWidth(window.innerWidth);
		window.addEventListener("popstate", onPop);
		window.addEventListener("resize", onResize);
		// The app replaces the URL itself (select, tabs…): follow it.
		const poll = window.setInterval(onPop, 300);
		return () => {
			window.removeEventListener("popstate", onPop);
			window.removeEventListener("resize", onResize);
			window.clearInterval(poll);
		};
	}, []);
	const route = useMemo<WorkspaceRouteBinding>(
		() => ({
			splat: loc.splat,
			search: loc.search,
			go: (t, opts) => {
				const url = hrefOf(t);
				if (opts?.replace) history.replaceState(history.state, "", url);
				else history.pushState(history.state, "", url);
				window.dispatchEvent(
					new PopStateEvent("popstate", { state: history.state }),
				);
			},
			href: hrefOf,
		}),
		[loc],
	);
	if (!graph) return null;
	const live = (win.__suggestHarness?.proposals ?? "fixture") === "live";
	const render = (g: TripGraph, proposals: ProposalDto[]) => (
		<WorkspaceModelProvider
			graph={g}
			mode={live ? "live" : "fixture"}
			connection="live"
			route={route}
			proposals={proposals}
		>
			<Slots compact={width < 1024} />
		</WorkspaceModelProvider>
	);
	return live ? (
		<LiveData tripId={graph.trip.id} fallback={graph}>
			{render}
		</LiveData>
	) : (
		render(graph, [...scenario.proposals, NOTE_DEMO])
	);
}

if (!win.__suggestHarnessMounted) {
	win.__suggestHarnessMounted = true;
	const host = document.createElement("div");
	host.id = "suggest-harness";
	document.body.appendChild(host);
	// The app's own QueryClient (a real mount shares it: mutations refresh the
	// app's queries, the live channel refreshes ours); else the app's factory.
	const qc = appQueryClient() ?? makeQueryClient();
	createRoot(host).render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<HarnessRoot />
			</TooltipProvider>
		</QueryClientProvider>,
	);
}
