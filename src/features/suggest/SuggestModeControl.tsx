/**
 * E7 the mode control in the TopBar (EXTENSIONS §3.7): editors get a split
 * button "Editing ▾ · 3" / "Suggesting ▾ · 3" (Editing / Suggesting, Show
 * suggestions, Review…); suggesters a static "Suggesting · 3" pill (it opens
 * their suggestions) with "Your changes go to Dennis and Maya for review",
 * and a one-time hint under it the first time. Hidden when there are no
 * suggestions and the mode is edit, and for viewers.
 *
 * Suggest-mode chrome: while suggesting, a 2px `--primary/40` rule tops the
 * center panel (and the mobile sheet) through `html[data-yonder-suggesting]`
 * (see `suggest.css`); the header travels with every server call (F).
 *
 * `compact` (TopBar at md, the mobile pill row): icon + count only. Left
 * unset, it follows the phone breakpoint (the mobile pill row is narrow).
 *
 * Because the control hides itself for an editor with nothing to review, the
 * way INTO suggest mode then is `SuggestModeMenuItem` ("Suggest changes
 * instead"), which WP-Shell puts in the trip-title ▾ menu (M6).
 */
import "./suggest.css";
import { cn } from "cn";
import {
	ChevronDown,
	Eye,
	ListChecks,
	MessageSquareDiff,
	PencilLine,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { isMine, reviewerFirstNames, reviewersLine } from "./proposal-view";
import { openReview } from "./review-store";
import { SUGGEST_TESTID } from "./testids";
import { useAuthorFeedback } from "./use-author-feedback";
import { useBaseIndex } from "./use-base-index";

// ---------------------------------------------------------------------------
// Suggest-mode chrome: one attribute on <html>, ref-counted across mounts.
// ---------------------------------------------------------------------------

let chromeUsers = 0;
function useSuggestChrome(on: boolean) {
	useEffect(() => {
		if (!on || typeof document === "undefined") return;
		chromeUsers++;
		document.documentElement.setAttribute("data-yonder-suggesting", "");
		return () => {
			chromeUsers--;
			if (chromeUsers <= 0) {
				chromeUsers = 0;
				document.documentElement.removeAttribute("data-yonder-suggesting");
			}
		};
	}, [on]);
}

// ---------------------------------------------------------------------------
// The first-time hint for suggesters (per browser, per trip).
// ---------------------------------------------------------------------------

const hintKey = (tripId: string) => `yonder:suggest-hint:${tripId}`;

function readHintSeen(tripId: string): boolean {
	try {
		return globalThis.localStorage?.getItem(hintKey(tripId)) === "1";
	} catch {
		return true; // no storage: never nag
	}
}

function writeHintSeen(tripId: string) {
	try {
		globalThis.localStorage?.setItem(hintKey(tripId), "1");
	} catch {
		// Private mode: the hint just comes back next time.
	}
}

const count = (n: number) => (
	<span className="font-mono text-xs tnum">{n}</span>
);

export function SuggestModeControl({
	compact: compactProp,
}: {
	/** Icon + count only (TopBar at md, the mobile pill row). Default: on phones. */
	compact?: boolean;
} = {}) {
	const mobile = useIsMobile();
	const compact = compactProp ?? mobile;
	const { access, proposals, graph, mode } = useWorkspace();
	const ix = useBaseIndex();
	const tripId = graph.trip.id;
	const setSuggesting = useUi((s) => s.setSuggesting);
	const suggesting = access.mode === "suggest";
	useSuggestChrome(suggesting);
	useAuthorFeedback(proposals.list, graph, ix, mode === "live");

	const isEditor = access.canReview;
	const isSuggester = !isEditor && access.canPropose;
	const n = proposals.count;

	const [hintOpen, setHintOpen] = useState(false);
	// The mode tooltip stays quiet while the menu is open and when focus
	// returns to the trigger as it closes (it would repeat what was just chosen).
	const [tipOpen, setTipOpen] = useState(false);
	const menuOpen = useRef(false);
	const quietUntil = useRef(0);
	const onTipOpenChange = useCallback((o: boolean) => {
		setTipOpen(o && !menuOpen.current && Date.now() > quietUntil.current);
	}, []);
	const onMenuOpenChange = useCallback((o: boolean) => {
		menuOpen.current = o;
		if (!o) quietUntil.current = Date.now() + 500;
		setTipOpen(false);
	}, []);
	useEffect(() => {
		if (isSuggester && mode === "live") setHintOpen(!readHintSeen(tripId));
	}, [isSuggester, mode, tripId]);

	if (!isEditor && !isSuggester) return null;
	if (n === 0 && !suggesting) return null;

	if (isSuggester) {
		const names = reviewerFirstNames(graph);
		const line = reviewersLine(names);
		const mineOpen = proposals.list.some(
			(p) => p.status === "open" && isMine(p, graph.me.userId),
		);
		const dismiss = () => {
			writeHintSeen(tripId);
			setHintOpen(false);
		};
		return (
			<Popover open={hintOpen} onOpenChange={(o) => (o ? null : dismiss())}>
				<Tooltip>
					<PopoverAnchor asChild>
						<TooltipTrigger asChild>
							<button
								type="button"
								data-testid={TESTID.suggestModeControl}
								data-mode="suggest"
								aria-label={`Suggesting${n ? ` · ${n} open` : ""}. ${line}`}
								onClick={() => openReview(mineOpen ? "mine" : "open")}
								className={cn(
									"inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/[0.06] text-sm font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
									compact ? "h-8 px-2.5" : "h-8 px-3",
								)}
							>
								<MessageSquareDiff className="size-4" strokeWidth={1.5} />
								{compact ? null : <span>Suggesting</span>}
								{n ? (
									<>
										{compact ? null : (
											<span aria-hidden className="text-primary/50">
												·
											</span>
										)}
										{count(n)}
									</>
								) : null}
							</button>
						</TooltipTrigger>
					</PopoverAnchor>
					<TooltipContent>{line}</TooltipContent>
				</Tooltip>
				<PopoverContent
					align="end"
					data-testid={SUGGEST_TESTID.firstHint}
					className="w-72 p-3"
					onOpenAutoFocus={(e) => e.preventDefault()}
				>
					<p className="text-sm font-medium">You're suggesting</p>
					<p className="mt-1 text-[13px] leading-[18px] text-muted-foreground">
						Edit as usual — {line.charAt(0).toLowerCase()}
						{line.slice(1)}
					</p>
					<div className="mt-3 flex justify-end">
						<Button size="sm" variant="outline" onClick={dismiss}>
							Got it
						</Button>
					</div>
				</PopoverContent>
			</Popover>
		);
	}

	// Editors: the mode menu + the count that opens the review.
	const ModeIcon = suggesting ? MessageSquareDiff : PencilLine;
	const label = suggesting ? "Suggesting" : "Editing";
	const menu = (
		<DropdownMenuContent
			align="end"
			className="w-72"
			data-testid={SUGGEST_TESTID.modeMenu}
		>
			<DropdownMenuLabel className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
				Mode
			</DropdownMenuLabel>
			<DropdownMenuRadioGroup
				value={suggesting ? "suggest" : "edit"}
				onValueChange={(v) => setSuggesting(tripId, v === "suggest")}
			>
				<DropdownMenuRadioItem
					value="edit"
					data-testid={SUGGEST_TESTID.modeEditing}
					className="items-start"
				>
					<PencilLine className="mt-0.5" strokeWidth={1.5} />
					<span className="grid">
						<span>Editing</span>
						<span className="text-xs text-muted-foreground">
							Changes apply right away
						</span>
					</span>
				</DropdownMenuRadioItem>
				<DropdownMenuRadioItem
					value="suggest"
					data-testid={SUGGEST_TESTID.modeSuggesting}
					className="items-start"
				>
					<MessageSquareDiff className="mt-0.5" strokeWidth={1.5} />
					<span className="grid">
						<span>Suggesting</span>
						<span className="text-xs text-muted-foreground">
							Changes wait for someone to accept them
						</span>
					</span>
				</DropdownMenuRadioItem>
			</DropdownMenuRadioGroup>
			<DropdownMenuSeparator />
			<DropdownMenuItem
				data-testid={SUGGEST_TESTID.showSwitch}
				onSelect={(e) => {
					e.preventDefault();
					proposals.setShow(!proposals.show);
				}}
			>
				<Eye strokeWidth={1.5} />
				<span className="flex-1">Show suggestions</span>
				<Switch
					checked={proposals.show}
					tabIndex={-1}
					aria-hidden
					className="pointer-events-none"
				/>
			</DropdownMenuItem>
			<DropdownMenuItem
				data-testid={SUGGEST_TESTID.reviewOpen}
				onSelect={() => openReview("open")}
			>
				<ListChecks strokeWidth={1.5} />
				<span className="flex-1">Review…</span>
				{n ? (
					<span className="font-mono text-xs text-muted-foreground tnum">
						{n}
					</span>
				) : null}
			</DropdownMenuItem>
		</DropdownMenuContent>
	);

	const tone = suggesting
		? "border-primary/30 bg-primary/[0.06] text-primary hover:bg-primary/10 hover:text-primary"
		: "";

	if (compact) {
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						data-testid={TESTID.suggestModeControl}
						data-mode={suggesting ? "suggest" : "edit"}
						aria-label={`${label}${n ? `, ${n} suggestions` : ""}`}
						className={cn("h-8 gap-1 rounded-full px-2.5", tone)}
					>
						<ModeIcon strokeWidth={1.5} />
						{n ? count(n) : null}
					</Button>
				</DropdownMenuTrigger>
				{menu}
			</DropdownMenu>
		);
	}

	return (
		<ButtonGroup
			data-testid={TESTID.suggestModeControl}
			data-mode={suggesting ? "suggest" : "edit"}
			aria-label="Suggestions"
		>
			<DropdownMenu onOpenChange={onMenuOpenChange}>
				<Tooltip open={tipOpen} onOpenChange={onTipOpenChange}>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								className={cn("gap-1.5 pr-2", tone)}
								aria-label={`Mode: ${label}`}
							>
								<ModeIcon strokeWidth={1.5} />
								{label}
								<ChevronDown className="size-3.5 opacity-60" />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>
						{suggesting
							? "Suggesting — your changes need approval"
							: "Editing — your changes apply right away"}
					</TooltipContent>
				</Tooltip>
				{menu}
			</DropdownMenu>
			{n ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							className={cn("min-w-8 px-2", tone)}
							onClick={() => openReview("open")}
							aria-label={`Review ${n} suggestion${n === 1 ? "" : "s"}`}
						>
							{count(n)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>Review suggestions</TooltipContent>
				</Tooltip>
			) : null}
		</ButtonGroup>
	);
}

/**
 * "Suggest changes instead" / "Back to editing" for WP-Shell's trip-title ▾
 * menu (M6): the entry into suggest mode while `SuggestModeControl` is hidden
 * (no suggestions yet). Editors and owners only; renders inside a
 * `DropdownMenuContent`.
 */
export function SuggestModeMenuItem() {
	const { access, graph } = useWorkspace();
	const setSuggesting = useUi((s) => s.setSuggesting);
	if (!access.canReview) return null;
	const suggesting = access.mode === "suggest";
	const Icon = suggesting ? PencilLine : MessageSquareDiff;
	return (
		<DropdownMenuItem
			data-testid={SUGGEST_TESTID.modeMenuItem}
			onSelect={() => setSuggesting(graph.trip.id, !suggesting)}
		>
			<Icon strokeWidth={1.5} />
			{suggesting ? "Back to editing" : "Suggest changes instead"}
		</DropdownMenuItem>
	);
}
