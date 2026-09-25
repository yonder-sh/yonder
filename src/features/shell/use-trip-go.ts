/**
 * Navigate inside the current trip with several search params at once
 * (`nav.*` changes one at a time): "Still to plan" rows open the Lists tab on
 * the to-do list, or the Outline/Ideas/map with the shared `f` filter.
 * `root: true` goes to the trip root (the filter and lists read everything);
 * `scopeId` goes to that scope instead (a to-do's place), with a fresh search.
 * In fixture mode it rewrites the same URL shape under `/dev/fixture`.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { cleanSearch, splatFor } from "@/lib/workspace/nav";
import type { WorkspaceSearch } from "@/lib/workspace/search";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export function useTripGo(): (
	patch: Partial<WorkspaceSearch>,
	opts?: { root?: boolean; scopeId?: string | null; replace?: boolean },
) => void {
	const ws = useWorkspace();
	const navigate = useNavigate();
	const slug = ws.graph.trip.slug;
	const splatNow = ws.scopePath.map((n) => n.slug).join("/");
	const { search, mode, ix } = ws;
	return useCallback(
		(patch, opts = {}) => {
			const fresh = opts.root || opts.scopeId !== undefined;
			const splat = opts.scopeId
				? splatFor(ix, opts.scopeId)
				: fresh
					? ""
					: splatNow;
			const next = cleanSearch({
				...(fresh ? {} : search),
				...(fresh ? { lens: undefined } : {}),
				...patch,
			} as WorkspaceSearch);
			if (mode === "fixture") {
				if (splat)
					void navigate({
						to: "/dev/fixture/$",
						params: { _splat: splat },
						search: next,
						replace: opts.replace,
					});
				else
					void navigate({
						to: "/dev/fixture",
						search: next,
						replace: opts.replace,
					});
				return;
			}
			if (splat)
				void navigate({
					to: "/t/$trip/$",
					params: { trip: slug, _splat: splat },
					search: next,
					replace: opts.replace,
				});
			else
				void navigate({
					to: "/t/$trip",
					params: { trip: slug },
					search: next,
					replace: opts.replace,
				});
		},
		[navigate, slug, splatNow, search, mode, ix],
	);
}

/** One line of list Markdown as plain text ("Washi tape for @Maya Chen"). */
export function plainText(md: string): string {
	return md
		.replace(/\[@((?:[^[\]\\]|\\.){1,80})\]\(mention:[0-9a-f-]{36}\)/gi, "@$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`~]+/g, "")
		.replace(/\\([[\]\\])/g, "$1")
		.trim();
}
