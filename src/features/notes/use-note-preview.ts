/**
 * The first line of a target's SHARED note, for Plan cards and pins (SPEC
 * §12.5 `useNotePreview(target)`; QA NOTE-07). Reads the derived plain text
 * (`yjs_documents.plain_text`), so no editor or socket per card; an empty note
 * gives null (no preview). Private notes never preview (ADDENDUM §7.2).
 */
import { useQuery } from "@tanstack/react-query";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { noteFor, tripNotesQuery } from "./queries";

export function useNotePreview(target: BundleTarget | null): string | null {
	const ws = useWorkspaceOptional();
	const q = useQuery({
		...tripNotesQuery(ws?.graph.trip.id ?? ""),
		enabled: !!ws && ws.mode === "live" && target !== null,
	});
	if (!target) return null;
	const text = noteFor(q.data, target)?.plainText?.trim();
	if (!text) return null;
	const first = text.split("\n").find((l) => l.trim()) ?? "";
	return first.trim() || null;
}
