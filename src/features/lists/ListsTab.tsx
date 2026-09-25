/**
 * The Lists tab (SPEC §12.5 `ListsTab()`, DESIGN §7.3, EXTENSIONS §7):
 * to-dos and shopping rolled up over the scope (SPEC §8.4; the rollup toggle
 * "Everything inside · Only Tokyo" above is the shell's). Todo | Shopping
 * switch — or both side by side when the panel is ≥ 640px wide. At the trip
 * root Todo opens in View = Due: the MAIN list of everything, overdue first.
 * The list is the URL's `list=todo|shopping` (the inbox deep-links with it).
 */
import { cn } from "cn";
import { useEffect, useMemo, useRef, useState } from "react";
import { oneOf, useMirror } from "@/lib/realtime/view-ui";
import type { ListKind } from "@/lib/schemas/enums";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ListBoard } from "./ListBoard";
import { rollupRows, type ScopeOptions } from "./list-model";
import { useListItems } from "./queries";
import { LISTS_TESTID } from "./testids";

const KIND_KEY = "yonder:lists:kind";
const isListKind = oneOf<ListKind>(["todo", "shopping"]);
const SIDE_BY_SIDE_PX = 640;

export function ListsTab() {
	const ws = useWorkspace();
	const { graph, scope, only, days, lens, model, search, who, nav } = ws;
	const { items, loading } = useListItems();
	const root = useRef<HTMLDivElement>(null);
	const [wide, setWide] = useState(false);
	// The list is in the URL (`list`, so a deep link or the inbox opens the
	// right one); without it, the last one this browser used.
	const [stored, setStored] = useState<ListKind>("todo");
	useEffect(() => {
		try {
			const k = localStorage.getItem(KIND_KEY);
			if (k === "todo" || k === "shopping") setStored(k);
		} catch {
			// storage blocked
		}
	}, []);
	const kind: ListKind = search.list ?? stored;
	// FB-21d: a follower opens the same list even when it isn't in the URL.
	useMirror("lists.kind", kind, setStored, isListKind);
	const pickKind = (k: ListKind) => {
		setStored(k);
		try {
			localStorage.setItem(KIND_KEY, k);
		} catch {
			// storage blocked
		}
		if (k !== search.list) nav.setList(k);
	};

	useEffect(() => {
		const el = root.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(([e]) =>
			setWide((e?.contentRect.width ?? 0) >= SIDE_BY_SIDE_PX),
		);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const scopeId = scope?.id ?? null;
	const opts = useMemo<ScopeOptions>(
		() => ({
			scopeId,
			lens,
			includeDescendants: !only,
			dayRange: days,
			model,
		}),
		[scopeId, lens, only, days, model],
	);
	const addTarget = useMemo<BundleTarget>(
		() => (scopeId ? { kind: "node", nodeId: scopeId } : { kind: "trip" }),
		[scopeId],
	);
	const where = scope?.name ?? graph.trip.name;
	// Open rows in view, per list (the switch's counts).
	const counts = useMemo(() => {
		const c = { todo: 0, shopping: 0 };
		const seen = new Set<string>();
		for (const g of rollupRows(ws.ix, items, opts))
			for (const s of g.subs)
				for (const r of s.rows) {
					if (seen.has(r.id) || r.status !== "open") continue;
					seen.add(r.id);
					c[r.list] += 1;
				}
		return c;
	}, [ws.ix, items, opts]);

	const common = {
		items,
		scope: opts,
		addTarget,
		storageScope: scopeId ?? "root",
		who,
		setWho: nav.setWho,
		where,
		loading,
	};

	const switcher = (
		<div
			role="tablist"
			aria-label="Which list"
			className="inline-flex h-7 items-center rounded-full border p-0.5 text-xs"
		>
			{(["todo", "shopping"] as const).map((k) => (
				<button
					key={k}
					type="button"
					role="tab"
					aria-selected={kind === k}
					data-testid={
						k === "todo" ? LISTS_TESTID.kindTodo : LISTS_TESTID.kindShopping
					}
					onClick={() => pickKind(k)}
					className={cn(
						"inline-flex h-6 items-center gap-1.5 rounded-full px-3 transition-colors",
						kind === k
							? "bg-foreground text-background"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{k === "todo" ? "To-do" : "Shopping"}
					{counts[k] ? (
						<span
							className={cn(
								"font-mono tnum",
								kind === k ? "text-background/70" : "text-muted-foreground",
							)}
						>
							{counts[k]}
						</span>
					) : null}
				</button>
			))}
		</div>
	);

	return (
		<div ref={root} data-testid={TESTID.listsTab} className="pb-16">
			{wide ? (
				<div className="grid grid-cols-2 divide-x">
					<ListBoard {...common} kind="todo" title="To-do" />
					<ListBoard {...common} kind="shopping" title="Shopping" />
				</div>
			) : (
				<ListBoard key={kind} {...common} kind={kind} headerStart={switcher} />
			)}
		</div>
	);
}
