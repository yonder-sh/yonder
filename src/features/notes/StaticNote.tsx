/**
 * A note rendered from its saved JSON (DESIGN §7.4): the offline copy, the
 * descendant/item/day sections of the Notes tab, and the moment before the
 * live document syncs. The renderer (`StaticNoteRender`, TipTap's static
 * renderer) loads lazily, so the TipTap chunk isn't part of the workspace's
 * first load (QA VIS3-08, SPEC §19 PERF-05); until it's there, `PlainNote`
 * shows the same text in the same styles.
 */
import { lazy, memo, Suspense } from "react";
import { PlainNote } from "./plain-note";
import "./notes.css";

const Render = lazy(() => import("./StaticNoteRender"));

function StaticNoteLazy(props: { json: unknown; className?: string }) {
	return (
		<Suspense fallback={<PlainNote {...props} />}>
			<Render {...props} />
		</Suspense>
	);
}

export const StaticNote = memo(StaticNoteLazy);
