/**
 * DESIGN §4.1 breadcrumb: Trip › Japan › Tokyo ▾ · 5–7 Oct ✕. The last crumb
 * opens a switcher of its siblings; earlier crumbs zoom out to that level; the
 * day-range chip clears `days`.
 *
 * A scope change slides the crumbs over 600 ms on the zoom easing (DESIGN
 * §4.1, §11): in from the right when zooming in (or across), from the left
 * when zooming out; a 120 ms crossfade with reduced motion.
 */

/** The slide for a scope change from depth `from` to depth `to` (null = first render). */
export function crumbSlide(from: number | null, to: number): string | null {
	if (from === null) return null;
	return to < from ? "slide-in-from-left-4" : "slide-in-from-right-4";
}

/**
 * Deep scopes (HIER-02, PLAN-I2-11): more crumbs than this (All places plus
 * six levels) collapse the middle into "…", and so does a shallower path
 * whose crumbs would otherwise be squeezed into ellipses.
 */
export const MAX_FULL_CRUMBS = 6;

/**
 * Which crumbs show, by index: all of them, or "All places › Japan › … ›
 * Deep8 › Deep9" (the first two, a gap, the last two). A gap only when it
 * hides something (five crumbs or more).
 */
export function crumbLayout(
	count: number,
	collapse: boolean,
): { shown: (number | "gap")[]; hidden: number[] } {
	const all = Array.from({ length: count }, (_, i) => i);
	if (!collapse || count < 5) return { shown: all, hidden: [] };
	return {
		shown: [0, 1, "gap", count - 2, count - 1],
		hidden: all.slice(2, count - 2),
	};
}

import { cn } from "cn";
import { ChevronDown, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TypeGlyph } from "@/components/common/glyphs";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { formatDateRange } from "@/lib/format";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CrumbPresence } from "./cursors/presence-ui";
import { SHELL_TESTID } from "./testids";

const useIsoLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The window width, so a squeeze measured at one width is re-checked at another. */
function useViewportWidth(): number {
	const [w, setW] = useState(() =>
		typeof window === "undefined" ? 0 : window.innerWidth,
	);
	useEffect(() => {
		const on = () => setW(window.innerWidth);
		window.addEventListener("resize", on);
		return () => window.removeEventListener("resize", on);
	}, []);
	return w;
}

export function ScopeBreadcrumb({
	className,
	compact = false,
}: {
	className?: string;
	/** Tablet widths (md, lg): only the current place (its ▾ switches siblings). */
	compact?: boolean;
}) {
	const { ix, scope, scopePath, days, nav } = useWorkspace();
	const [open, setOpen] = useState(false);
	// Remember the previous scope to pick the slide direction (only on change).
	const prev = useRef<{ id: string | null; depth: number } | null>(null);
	const scopeKey = scope?.id ?? null;
	const depth = scopePath.length;
	const slide = useRef<{ key: string | null; cls: string | null }>({
		key: scopeKey,
		cls: null,
	});
	if (slide.current.key !== scopeKey) {
		slide.current = {
			key: scopeKey,
			cls: crumbSlide(prev.current?.depth ?? null, depth),
		};
	}
	prev.current = { id: scopeKey, depth };
	const siblings = ix.children(scope?.parentId ?? null);
	// The trip name is already the title menu; the root crumb only appears as a
	// way back up once you're inside a place.
	const crumbs = scope
		? [
				{ id: null as string | null, name: "All places" },
				...scopePath.map((n) => ({ id: n.id as string | null, name: n.name })),
			]
		: [];
	const last = crumbs.length - 1;
	// Collapse deep paths; and a shallower one when its crumbs don't fit (measured
	// once per scope and window width, against the window so collapsing, which
	// narrows the crumbs, can't flip it back).
	const olRef = useRef<HTMLOListElement>(null);
	const vw = useViewportWidth();
	const measureKey = `${scopeKey ?? "root"}|${vw}`;
	const [squeezedAt, setSqueezedAt] = useState<string | null>(null);
	const collapse =
		!compact && (crumbs.length > MAX_FULL_CRUMBS || squeezedAt === measureKey);
	const layout = crumbLayout(crumbs.length, collapse);
	useIsoLayoutEffect(() => {
		if (compact || collapse || crumbs.length < 5) return;
		const labels =
			olRef.current?.querySelectorAll<HTMLElement>("[data-crumb-label]") ?? [];
		const cut = [...labels].some(
			(el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1,
		);
		if (cut) setSqueezedAt(measureKey);
	}, [compact, collapse, crumbs.length, measureKey]);
	return (
		<nav
			aria-label="Scope"
			data-testid={TESTID.scopeBreadcrumb}
			className={cn("flex min-w-0 items-center gap-1 text-sm", className)}
		>
			<ol
				ref={olRef}
				key={scopeKey ?? "root"}
				className={cn(
					"flex min-w-0 items-center gap-1",
					slide.current.cls && [
						"animate-in fade-in-0 duration-[600ms] ease-[cubic-bezier(.22,1,.36,1)]",
						slide.current.cls,
						"motion-reduce:slide-in-from-left-0 motion-reduce:slide-in-from-right-0 motion-reduce:duration-[120ms]",
					],
				)}
			>
				{layout.shown.map((slot, k) => {
					if (slot === "gap")
						return (
							<Fragment key="gap">
								<li aria-hidden="true" className="text-muted-foreground">
									›
								</li>
								<li className="hidden shrink-0 sm:block">
									<DropdownMenu>
										<DropdownMenuTrigger
											data-testid={SHELL_TESTID.crumbOverflow}
											aria-label={`${layout.hidden.length} more levels`}
											className="rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
										>
											…
										</DropdownMenuTrigger>
										<DropdownMenuContent
											align="start"
											className="max-h-[60vh] w-72 overflow-y-auto"
										>
											{crumbs.map((c, i) => (
												<DropdownMenuItem
													key={c.id ?? "root"}
													onSelect={() => i !== last && nav.zoomTo(c.id)}
													aria-current={i === last ? "location" : undefined}
													style={{ paddingLeft: 8 + Math.min(i, 8) * 8 }}
													className={cn("min-w-0", i === last && "font-medium")}
												>
													<span className="truncate">{c.name}</span>
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
								</li>
							</Fragment>
						);
					const i = slot;
					const c = crumbs[i];
					if (!c) return null;
					return (
						<Fragment key={c.id ?? "root"}>
							{k > 0 && !compact ? (
								<li aria-hidden="true" className="text-muted-foreground">
									›
								</li>
							) : null}
							<li
								className={cn(
									"min-w-0",
									i < last && (compact ? "hidden" : "hidden shrink sm:block"),
									i === 0 && last > 0 && "max-w-40",
								)}
							>
								{i === last && scope ? (
									<Popover open={open} onOpenChange={setOpen}>
										<PopoverTrigger
											className="flex max-w-56 min-w-0 items-center gap-1 rounded-md px-1.5 py-1 font-medium hover:bg-accent"
											aria-label={`${c.name}: switch to a sibling`}
										>
											<span data-crumb-label className="truncate">
												{c.name}
											</span>
											{/* FB-17a: who else is here. */}
											<CrumbPresence nodeId={c.id} />
											<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
										</PopoverTrigger>
										<PopoverContent className="w-64 p-0" align="start">
											<Command>
												<CommandInput placeholder="Go to…" />
												<CommandList>
													<CommandEmpty>No matches.</CommandEmpty>
													<CommandGroup>
														{siblings.map((s) => (
															<CommandItem
																key={s.id}
																value={`${s.name} ${s.id}`}
																onSelect={() => {
																	setOpen(false);
																	nav.zoomTo(s.id);
																}}
															>
																<TypeGlyph
																	type={s.type}
																	category={s.category}
																/>
																<span
																	className={cn(
																		"truncate",
																		s.id === scope.id && "font-medium",
																	)}
																>
																	{s.name}
																</span>
																<CrumbPresence nodeId={s.id} />
															</CommandItem>
														))}
													</CommandGroup>
												</CommandList>
											</Command>
										</PopoverContent>
									</Popover>
								) : (
									<button
										type="button"
										onClick={() => nav.zoomTo(c.id)}
										className={cn(
											"flex max-w-full min-w-0 items-center rounded-md px-1.5 py-1 hover:bg-accent",
											i === last
												? "font-medium text-foreground"
												: "text-muted-foreground hover:text-foreground",
										)}
										aria-current={i === last ? "location" : undefined}
									>
										<span data-crumb-label className="truncate">
											{c.name}
										</span>
										<CrumbPresence nodeId={c.id} />
									</button>
								)}
							</li>
						</Fragment>
					);
				})}
			</ol>
			{days ? (
				<span
					data-testid={TESTID.dayRangeChip}
					className="ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-muted pr-1 pl-2 font-mono text-[13px] tnum"
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
			) : null}
		</nav>
	);
}
