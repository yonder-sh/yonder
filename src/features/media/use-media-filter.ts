/**
 * The Media tab's filter lives in the URL (`mf`, SPEC §12.1) so it deep-links;
 * `nav.setMediaFilter` writes it with a replace navigation.
 */
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { MediaFilter } from "./media-kinds";

export function useMediaFilter(): [
	MediaFilter | null,
	(v: MediaFilter | null) => void,
] {
	const { search, nav } = useWorkspace();
	return [search.mf ?? null, nav.setMediaFilter];
}
