/**
 * ADDENDUM §6 "shopping list link": an open shopping item with a rough price
 * is a planned cost ("~¥30,000"); "Bought" opens Add expense prefilled and
 * linked to the item (`listItemId`; a private item's expense starts
 * private), with the tax-free flag one switch away.
 */
import { Lock } from "lucide-react";
import { EditGuard } from "@/components/common/edit-guard";
import { MarkdownText } from "@/components/common/markdown-text";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/engine/money";
import { targetLabel } from "@/lib/engine/money-scope";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CategoryGlyph, Num } from "./money-ui";
import { plainText } from "./shopping";
import { MONEY_TESTID } from "./testids";
import type { Display, ShoppingRow as Row } from "./use-money";

export function ShoppingRow({
	row,
	display: d,
	writer,
}: {
	row: Row;
	display: Display;
	writer: boolean;
}) {
	const { ix } = useWorkspace();
	const open = useUi((s) => s.openAddExpense);
	const li = row.item;
	const bought = () =>
		open({
			target: li.target,
			title: plainText(li.text) || "Shopping",
			category: "shopping",
			amountMinor: row.amountMinor,
			currency: row.currency,
			listItemId: li.id,
			// Gift privacy (ADDENDUM §10): a private item's expense starts private.
			...(li.isPrivate ? { isPrivate: true } : {}),
		});
	return (
		<li
			data-testid={MONEY_TESTID.shoppingRow}
			className="flex items-start gap-3 px-4 py-2.5"
		>
			<CategoryGlyph category="shopping" className="mt-0.5" />
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<MarkdownText
						md={li.text}
						inline
						className="min-w-0 flex-1 truncate text-sm font-medium"
					/>
					<Num className="text-[13px] text-muted-foreground">
						~{formatMoney(row.amountMinor, row.currency)}
					</Num>
				</div>
				<div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
					{li.isPrivate ? (
						<span className="inline-flex items-center gap-1">
							<Lock className="size-3" aria-hidden="true" /> Only you
						</span>
					) : null}
					<span className="truncate">
						Shopping list · {targetLabel(ix, li.target)}
					</span>
					{row.homeMinor !== null && row.currency !== d.code ? (
						<span className="ml-auto shrink-0">
							≈ {formatMoney(d.toDisplay(row.homeMinor), d.code)}
						</span>
					) : null}
				</div>
			</div>
			{writer ? (
				<EditGuard>
					<Button
						size="xs"
						variant="outline"
						className="mt-0.5 shrink-0"
						onClick={bought}
					>
						Bought
					</Button>
				</EditGuard>
			) : null}
		</li>
	);
}
