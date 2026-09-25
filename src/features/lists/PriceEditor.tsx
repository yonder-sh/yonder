/**
 * Quantity and rough budget of a shopping item (DESIGN §7.3 "×2 · ¥30,000";
 * QA LIST-04). The currency defaults to the shop's country (JP → JPY,
 * KR → KRW, …), else the trip's home currency. The budget shows as a planned
 * cost in Money (WP-Money reads `priceAmount`/`priceCurrency`).
 */
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { currencyForCountry } from "@/lib/domain/currency";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { ListItemDto } from "./lists.functions";
import type { ListItemPatch } from "./server/proposable.server";

const COMMON = ["JPY", "KRW", "TWD", "VND", "USD", "CAD", "EUR", "TRY"];

export function PriceEditor({
	row,
	open,
	onOpenChange,
	onSave,
	children,
}: {
	row: ListItemDto;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSave: (patch: ListItemPatch) => void;
	children: ReactNode;
}) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverAnchor asChild>{children}</PopoverAnchor>
			<PopoverContent align="end" className="w-64 p-3">
				{open ? (
					<PriceForm
						row={row}
						onSave={(p) => {
							onSave(p);
							onOpenChange(false);
						}}
					/>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

function PriceForm({
	row,
	onSave,
}: {
	row: ListItemDto;
	onSave: (patch: ListItemPatch) => void;
}) {
	const { ix } = useWorkspace();
	const home = ix.settings.currency;
	const nodeId =
		row.target.kind === "node"
			? row.target.nodeId
			: row.target.kind === "item"
				? (ix.item(row.target.itemId)?.nodeId ?? null)
				: null;
	const country = nodeId
		? ix.path(nodeId).find((n) => n.countryCode)?.countryCode
		: null;
	const [qty, setQty] = useState(row.quantity ? String(row.quantity) : "");
	const [amount, setAmount] = useState(
		row.priceAmount != null ? String(row.priceAmount) : "",
	);
	const [currency, setCurrency] = useState(
		row.priceCurrency ?? currencyForCountry(country, home),
	);
	const q = Number.parseInt(qty, 10);
	const a = Number.parseFloat(amount.replace(/,/g, ""));
	const valid =
		(qty === "" || (Number.isFinite(q) && q > 0 && q <= 9999)) &&
		(amount === "" || (Number.isFinite(a) && a >= 0)) &&
		/^[A-Z]{3}$/.test(currency);
	const currencies = [...new Set([currency, home, ...COMMON])];
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (!valid) return;
				onSave({
					quantity: qty === "" ? null : q,
					priceAmount: amount === "" ? null : a,
					priceCurrency: amount === "" ? null : currency,
				});
			}}
		>
			<div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
				How many
				<Input
					inputMode="numeric"
					aria-label="How many"
					value={qty}
					onChange={(e) =>
						setQty(e.target.value.replace(/\D/g, "").slice(0, 4))
					}
					placeholder="1"
					className="h-8 w-20 text-right font-mono tnum"
				/>
			</div>
			<div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
				<span>Budget</span>
				<div className="flex items-center gap-1.5">
					<Input
						inputMode="decimal"
						aria-label="Budget amount"
						value={amount}
						onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))}
						placeholder="0"
						className="h-8 w-24 text-right font-mono tnum"
					/>
					<select
						aria-label="Currency"
						value={currency}
						onChange={(e) => setCurrency(e.target.value)}
						className="h-8 rounded-md border border-input bg-transparent px-1.5 font-mono text-xs"
					>
						{currencies.map((c) => (
							<option key={c} value={c}>
								{c}
							</option>
						))}
					</select>
				</div>
			</div>
			<div className="flex justify-end">
				<Button type="submit" size="sm" disabled={!valid}>
					Save
				</Button>
			</div>
		</form>
	);
}
