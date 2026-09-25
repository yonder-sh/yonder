/**
 * FB-24 form presence in React: the inspector's chip ("Dennis is editing NH
 * 744 · Seats" when someone edits the selected thing) and the follower's
 * banner ("Dennis opened 'Add expense'", non-interactive). The chips on
 * cards and rows are drawn by the cursor layer (`ghosts.ts`).
 */
import { useMemo } from "react";
import { presenceColor } from "@/components/common/member";
import { plainAnchorId } from "@/lib/realtime/cursor-protocol";
import { formBannerText, formChipText } from "@/lib/realtime/form-presence";
import { usePeers } from "@/lib/realtime/presence";
import type { Peer } from "@/lib/realtime/protocol";
import { AwarenessForm } from "@/lib/realtime/view-protocol";
import type { Sel } from "@/lib/workspace/search";
import { useAnchorLabel } from "./cursors/anchor-label";
import { SHELL_TESTID } from "./testids";

/** A peer's form (validated), or null. */
export function formOf(p: Peer | null | undefined): AwarenessForm | null {
	const r = AwarenessForm.safeParse(p?.form);
	return r.success ? r.data : null;
}

/** Is a form's target (`t`, an anchor id) the selection `sel`? */
export function formTargetsSel(t: string | null | undefined, sel: Sel | null) {
	if (!t || !sel) return false;
	const plain = plainAnchorId(t);
	const i = plain.indexOf(":");
	const kind = plain.slice(0, i);
	const id = plain.slice(i + 1);
	switch (sel.kind) {
		case "item":
			return kind === "item" && id === sel.id;
		case "day":
			return (kind === "dayh" || kind === "day") && id === sel.id;
		case "node":
			return (kind === "tree" || kind === "idea") && id === sel.id;
		case "leg":
			return (
				kind === "leg" &&
				id ===
					(sel.target.kind === "pair"
						? `l.${sel.target.fromItemId}.${sel.target.toItemId}`
						: `s.${sel.target.dayId}.${sel.target.end}`)
			);
		default:
			return false;
	}
}

/** The inspector's chips: people editing the selected thing. */
export function InspectorFormChips({
	sel,
	title,
}: {
	sel: Sel | null;
	title: string | null;
}) {
	const peers = usePeers();
	// The same name the chip on the row uses ("KE 724"), else the header's.
	const labelOf = useAnchorLabel();
	const editing = useMemo(
		() =>
			peers
				.map((p) => ({ p, f: formOf(p) }))
				.filter(({ f }) => f && formTargetsSel(f.t, sel)),
		[peers, sel],
	);
	if (!editing.length) return null;
	return (
		<div className="mt-2 flex flex-wrap gap-1.5">
			{editing.map(({ p, f }) =>
				f ? (
					<span
						key={p.user.id}
						data-testid={SHELL_TESTID.inspectorFormChip}
						className="inline-flex h-[22px] max-w-full items-center truncate rounded-[4px] px-2 text-[11px] font-semibold text-white"
						style={{ backgroundColor: presenceColor(p.user.color) }}
					>
						{formChipText(p.user.name, f, (f.t ? labelOf(f.t) : null) ?? title)}
					</span>
				) : null,
			)}
		</div>
	);
}

/** The follower's line under "Following Dennis": what dialog they opened. */
export function FollowFormBanner({ peer }: { peer: Peer | undefined }) {
	const f = formOf(peer);
	if (!peer || !f) return null;
	return (
		<div
			data-testid={SHELL_TESTID.followFormBanner}
			role="status"
			aria-live="polite"
			className="pointer-events-none flex h-6 shrink-0 items-center justify-center gap-1.5 px-3 text-[11px] text-muted-foreground"
			style={{
				backgroundColor: `color-mix(in oklab, ${presenceColor(peer.user.color)} 6%, var(--background))`,
			}}
		>
			<span
				aria-hidden="true"
				className="size-1.5 rounded-full"
				style={{ backgroundColor: presenceColor(peer.user.color) }}
			/>
			<span className="truncate">
				{formBannerText(peer.user.name, f)}
				{f.f ? ` · ${f.f}` : ""}
			</span>
		</div>
	);
}
