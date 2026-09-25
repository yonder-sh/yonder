import { cn } from "cn";
import { Fragment } from "react";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";

/**
 * "Japan › Tokyo › Shibuya" (12px muted). With `relativeTo`, ancestors at or
 * above that node are left out, so a crumb only shows what the scope doesn't.
 */
export function Crumbs({
	nodeIds,
	relativeTo,
	className,
}: {
	/** One node id (its path is shown) or an explicit path. */
	nodeIds: string | string[];
	relativeTo?: string | null;
	className?: string;
}) {
	const ws = useWorkspaceOptional();
	if (!ws) return null;
	const path = Array.isArray(nodeIds)
		? nodeIds.map((id) => ws.ix.node(id)).filter((n) => n !== undefined)
		: ws.ix.path(nodeIds);
	const cut = relativeTo ? path.findIndex((n) => n.id === relativeTo) : -1;
	const shown = path.slice(cut + 1);
	if (shown.length === 0) return null;
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground",
				className,
			)}
		>
			{shown.map((n, i) => (
				<Fragment key={n.id}>
					{i > 0 ? <span aria-hidden="true">›</span> : null}
					<span className="truncate">{n.name}</span>
				</Fragment>
			))}
		</span>
	);
}
