/**
 * E7 ghosts for media (EXTENSIONS §1.4 WP-Media: "Proposed link tiles render
 * with ProposalGhost"): an open `attachment.link` proposal becomes a dashed
 * tile in its author's colour, in the group of its target. Pure.
 *
 * A ghost and the attachment it becomes share one id (the proposal pins it),
 * and accepting refetches `media` and `proposals` side by side, so for a
 * moment both can say the link exists, or neither does (COLLAB-R3-05).
 * `withGhosts` keeps exactly one tile per id through that: the real row wins
 * over its ghost, and a just-accepted link keeps a plain tile until the media
 * list that holds it arrives.
 */
import type { ProposalMark } from "@/lib/engine/proposals";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { BundleTarget } from "@/lib/schemas/targets";
import { classifyUrl } from "./embeds";
import type { MediaDto } from "./types";

export function ghostMark(p: ProposalDto): ProposalMark {
	return {
		proposalId: p.id,
		op: p.op,
		kind: "create",
		author: {
			userId: p.author.userId,
			memberId: p.author.memberId,
			name: p.author.name,
			color: p.author.color,
		},
	};
}

/** The tile id an `attachment.link` proposal stands for (its pinned attachment id). */
export function linkTileId(p: ProposalDto): string {
	return p.entityId ?? p.id;
}

/** An `attachment.link` proposal as a (client-only) tile; null when a guest can't read its payload. */
function linkTile(p: ProposalDto, ghost: boolean): MediaDto | null {
	const target = BundleTarget.safeParse(p.payload.target);
	const url = typeof p.payload.url === "string" ? p.payload.url : null;
	if (!target.success || !url) return null;
	const c = classifyUrl(url);
	return {
		id: linkTileId(p),
		target: target.data,
		kind: c.kind,
		status: "ready",
		visibility: "everyone",
		mime: null,
		width: null,
		height: null,
		durationSec: null,
		thumbhash: null,
		takenAt: null,
		url,
		provider: c.provider,
		embedId: c.kind === "embed" ? c.embedId : null,
		title: null,
		siteName: null,
		caption: typeof p.payload.caption === "string" ? p.payload.caption : null,
		position: `~${p.createdAt}`,
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
		description: null,
		author: null,
		sizeBytes: null,
		hasThumb: false,
		hasImage: false,
		hasFavicon: false,
		aspect: c.kind === "embed" ? c.aspect : null,
		pages: 0,
		pageCount: null,
		igType: c.kind === "embed" && c.provider === "instagram" ? c.igType : null,
		license: null,
		licenseUrl: null,
		sourceUrl: null,
		fetch: null,
		mine: false,
		...(ghost ? { proposed: ghostMark(p) } : {}),
	};
}

/**
 * The media list a surface shows: the server's rows, then a ghost for each
 * open link proposal and a plain tile for each proposal in `bridge` (accepted
 * while this tab showed its ghost, with the media refetch still under way),
 * unless the attachment's row is already there. Never two tiles with one id.
 */
export function withGhosts(
	rows: readonly MediaDto[],
	proposals: readonly ProposalDto[],
	bridge: ReadonlySet<string> = new Set(),
): MediaDto[] {
	const ids = new Set(rows.map((r) => r.id));
	const extra: MediaDto[] = [];
	for (const p of proposals) {
		if (p.op !== "attachment.link") continue;
		const ghost = p.status === "open";
		if (!ghost && !(p.status === "accepted" && bridge.has(p.id))) continue;
		const id = linkTileId(p);
		if (ids.has(id)) continue;
		const tile = linkTile(p, ghost);
		if (!tile) continue;
		ids.add(id);
		extra.push(tile);
	}
	return extra.length ? [...rows, ...extra] : (rows as MediaDto[]);
}
