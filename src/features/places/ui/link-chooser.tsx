/**
 * D10 "Add · paste a link", inside ⌘K's list: the link's preview (what it
 * is, its title, the trip's places it names), then "Add it to a place, or
 * save a new one?": the places it names, the open place, a few nearby, a
 * search over every place, and New place… (the palette's search finds or
 * makes it, filed beside the open place or under the Where scope, which can
 * be changed). The preview can arrive late or not at all: the choices work
 * before it, and a failed one just shows the link's site.
 */
import { CornerDownLeft, Film, Globe, Plus, Search } from "lucide-react";
import { TypeGlyph } from "@/components/common/glyphs";
import { TreePicker } from "@/components/common/tree-picker";
import { Chip, Eyebrow } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { cleanShareName } from "@/features/home/share-classify";
import { displayHost } from "@/features/media/embeds";
import type { LinkPeek } from "@/features/media/media.functions";
import type { GraphNode } from "@/lib/engine/types";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { type LinkTarget, linkKind, targetMeta } from "../lib/link-targets";
import { PLACES_TESTID } from "../testids";

/** cmdk values: a place's row, and New place. */
export const LINK_TO = "link-to:";
export const LINK_NEW = "link:new";

export function LinkChooser({
	url,
	peek,
	loading,
	named,
	targets,
	openId,
	find,
	onFind,
	filed,
	parentId,
	onParent,
	busy,
	onAdd,
	onNew,
}: {
	url: string;
	peek: LinkPeek | undefined;
	loading: boolean;
	/** The trip's places the title or caption names ("Mentions …"). */
	named: readonly GraphNode[];
	targets: readonly LinkTarget[];
	openId: string | null;
	find: string;
	onFind: (v: string) => void;
	/** "Tokyo › Harajuku": where New place files. */
	filed: string;
	parentId: string | null;
	onParent: (id: string | null) => void;
	busy: boolean;
	onAdd: (n: GraphNode) => void;
	/** New place…: to the search, the link waiting. */
	onNew: () => void;
}) {
	const { ix } = useWorkspace();
	const kind = linkKind(url);
	const Icon = kind.social ? Film : Globe;
	// "The fluffiest café in Harajuku": no hashtags, handles or emoji.
	const title = cleanShareName(peek?.title, null) || peek?.title;
	const why = (t: LinkTarget) =>
		t.why === "named"
			? kind.social
				? "Named in the caption"
				: "Named on the page"
			: t.node.id === openId
				? "Selected"
				: null;
	const row = (t: LinkTarget) => {
		const tag = why(t);
		return (
			<CommandItem
				key={t.node.id}
				value={`${LINK_TO}${t.node.id}`}
				data-testid={
					t.node.id === openId
						? PLACES_TESTID.addLinkTo
						: PLACES_TESTID.linkTarget
				}
				data-node={t.node.id}
				disabled={busy}
				onSelect={() => onAdd(t.node)}
				className="group"
			>
				<TypeGlyph type={t.node.type} category={t.node.category} />
				<span className="grid min-w-0 flex-1">
					<span className="truncate">{t.node.name}</span>
					<span className="truncate text-xs text-muted-foreground">
						{targetMeta(ix, t.node.id)}
					</span>
				</span>
				{tag ? (
					<Chip size="sm" className="max-sm:hidden">
						{tag}
					</Chip>
				) : null}
				{/* ↵ on the highlighted row. */}
				<Kbd className="hidden group-data-[selected=true]:inline-flex">
					<CornerDownLeft className="size-3" />
				</Kbd>
			</CommandItem>
		);
	};
	const searching = find.trim().length > 0;
	const top = targets.filter((t) => t.why === "named" || t.why === "open");
	const nearby = targets.filter((t) => t.why === "nearby");
	return (
		<>
			<div
				data-testid={PLACES_TESTID.linkPreview}
				className="flex items-start gap-3 px-4 pt-4 pb-2"
			>
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
					<Icon className="size-4" strokeWidth={1.5} />
				</span>
				<div className="grid min-w-0 flex-1 gap-0.5">
					<Eyebrow as="p">{kind.label}</Eyebrow>
					{title ? (
						<p className="line-clamp-2 text-sm">“{title}”</p>
					) : loading ? (
						<span
							aria-hidden
							className="mt-1 h-3.5 w-2/3 animate-pulse rounded bg-muted"
						/>
					) : (
						<p className="truncate text-sm text-muted-foreground">
							{displayHost(url)}
						</p>
					)}
					{named.length ? (
						<p className="truncate text-meta text-muted-foreground">
							Mentions {named.map((n) => n.name).join(", ")}
						</p>
					) : null}
				</div>
			</div>
			<p className="px-4 pt-2 pb-1 text-sm font-medium">
				Add it to a place, or save a new one?
			</p>
			{searching ? (
				targets.length ? (
					<CommandGroup>{targets.map(row)}</CommandGroup>
				) : null
			) : (
				<>
					{top.length ? <CommandGroup>{top.map(row)}</CommandGroup> : null}
					{nearby.length ? (
						<CommandGroup heading="Nearby">{nearby.map(row)}</CommandGroup>
					) : null}
				</>
			)}
			<div className="px-3 py-1.5">
				<InputGroup className="h-9">
					<InputGroupAddon>
						<Search strokeWidth={1.5} />
					</InputGroupAddon>
					<InputGroupInput
						data-testid={PLACES_TESTID.linkSearch}
						aria-label="Search your places"
						placeholder="Search your places…"
						value={find}
						onChange={(e) => onFind(e.target.value)}
					/>
					<InputGroupAddon align="inline-end" className="max-sm:hidden">
						<InputGroupText className="text-xs font-normal">
							Any place in the trip
						</InputGroupText>
					</InputGroupAddon>
				</InputGroup>
				{searching && !targets.length ? (
					<p
						role="status"
						className="px-1 pt-2 text-meta text-muted-foreground"
					>
						No places in this trip match.
					</p>
				) : null}
			</div>
			<CommandGroup>
				<div className="relative">
					<CommandItem
						value={LINK_NEW}
						data-testid={PLACES_TESTID.linkNewPlace}
						disabled={busy}
						onSelect={onNew}
						className="group pr-20"
					>
						<Plus strokeWidth={1.5} />
						<span className="grid min-w-0 flex-1">
							<span className="truncate">New place…</span>
							<span className="truncate text-xs text-muted-foreground">
								Filed under {filed}
							</span>
						</span>
					</CommandItem>
					<TreePicker
						value={parentId}
						allowRoot
						filter={(n) => n.type !== "place"}
						onChange={onParent}
						trigger={
							<Button
								size="xs"
								variant="ghost"
								data-testid={PLACES_TESTID.linkFiling}
								aria-label={`Filed under ${filed}. Change`}
								className="absolute top-1/2 right-2 -translate-y-1/2"
							>
								Change
							</Button>
						}
					/>
				</div>
			</CommandGroup>
		</>
	);
}

/** The footer's keys with a pasted link: "↵ Add to Moffu · ⌘↵ New place…". */
export function LinkKeys({ enter }: { enter: string }) {
	return (
		<>
			<Kbd>
				<CornerDownLeft className="size-3" />
			</Kbd>
			<span className="max-w-48 truncate">{enter}</span>
			<Kbd className="ml-2">⌘</Kbd>
			<Kbd>
				<CornerDownLeft className="size-3" />
			</Kbd>
			New place…
		</>
	);
}
