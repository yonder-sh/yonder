/**
 * A place's category, changeable where it's shown (the inspector, the Places
 * tab's details and its table): the same list and colours as the map pins.
 * Read-only for people who can't edit (the edit guard says why).
 */
import { cn } from "cn";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { CategoryDot } from "@/components/common/glyphs";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { PLACE_CATEGORIES } from "@/lib/domain/taxonomy";
import type { GraphNode } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useUpdateNode } from "../mutations";

type Category = NonNullable<GraphNode["category"]>;

export function CategorySelect({
	node,
	className,
}: {
	node: GraphNode;
	className?: string;
}) {
	const { graph } = useWorkspace();
	const guard = useEditGuard();
	const update = useUpdateNode(graph.trip.id);
	return (
		<Select
			value={node.category ?? "other"}
			disabled={guard.disabled}
			onValueChange={(v) =>
				update.mutate(
					{ nodeId: node.id, patch: { category: v as Category } },
					{ onError: (e) => toast.error(humanError(e)) },
				)
			}
		>
			<SelectTrigger
				size="sm"
				aria-label="Category"
				title={guard.disabled ? (guard.reason ?? undefined) : undefined}
				className={cn(
					"h-7 w-fit gap-1.5 border-none px-1.5 shadow-none",
					className,
				)}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{Object.entries(PLACE_CATEGORIES).map(([k, c]) => (
					<SelectItem key={k} value={k}>
						<CategoryDot category={k as Category} />
						{c.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
