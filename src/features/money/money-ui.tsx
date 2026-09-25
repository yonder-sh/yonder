/**
 * Small WP-Money building blocks: the category glyph (muted: category family
 * colours are for place pins only), mono amounts, the 8px bar, section
 * headings and the status line ("¥10k of ¥60k"). DESIGN tokens only.
 */
import { cn } from "cn";
import {
	BedDouble,
	Receipt,
	ShoppingBag,
	Ticket,
	TramFront,
	UtensilsCrossed,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	EXPENSE_CATEGORY_LABEL,
	formatMoney,
	formatMoneyShort,
	paidInCurrency,
} from "@/lib/engine/money";
import type { ExpenseCategory } from "@/lib/schemas/enums";
import type { ExpenseDto } from "./money.functions";

const ICON = {
	lodging: BedDouble,
	transport: TramFront,
	food_drink: UtensilsCrossed,
	activities: Ticket,
	shopping: ShoppingBag,
	fees_other: Receipt,
} as const;

export function CategoryGlyph({
	category,
	className,
	size = 28,
}: {
	category: ExpenseCategory;
	className?: string;
	size?: 20 | 28;
}) {
	const Icon = ICON[category] ?? Receipt;
	return (
		<span
			title={EXPENSE_CATEGORY_LABEL[category]}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
				size === 28 ? "size-7" : "size-5",
				className,
			)}
		>
			<Icon className={size === 28 ? "size-3.5" : "size-3"} strokeWidth={1.5} />
		</span>
	);
}

export function CategoryIcon({
	category,
	className,
}: {
	category: ExpenseCategory;
	className?: string;
}) {
	const Icon = ICON[category] ?? Receipt;
	return <Icon className={cn("size-3.5", className)} strokeWidth={1.5} />;
}

/** Numbers in mono with tabular figures (DESIGN §2.6). */
export function Num({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return <span className={cn("font-mono tnum", className)}>{children}</span>;
}

/** An 8px bar: `value` of `max`; `over` marks the part past a budget. */
export function Bar({
	value,
	max,
	marker,
	className,
	tone = "ink",
	label,
}: {
	value: number;
	max: number;
	/** A second, lighter fill (e.g. planned behind paid). */
	marker?: number;
	className?: string;
	tone?: "ink" | "primary" | "warning";
	label?: string;
}) {
	const pct = (v: number) =>
		max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
	return (
		<div
			{...(label
				? { role: "img", "aria-label": label }
				: { "aria-hidden": true })}
			className={cn(
				"relative h-2 w-full overflow-hidden rounded-full bg-muted",
				className,
			)}
		>
			{marker !== undefined ? (
				<div
					className="absolute inset-y-0 left-0 rounded-full bg-foreground/20"
					style={{ width: `${pct(marker)}%` }}
				/>
			) : null}
			<div
				className={cn(
					"absolute inset-y-0 left-0 rounded-full",
					tone === "primary"
						? "bg-primary"
						: tone === "warning"
							? "bg-warning-hairline"
							: "bg-foreground/55",
				)}
				style={{ width: `${pct(value)}%` }}
			/>
		</div>
	);
}

/** Section overline: 11/14, 600, tracking .06em, uppercase (DESIGN §2.6). */
export function Overline({
	children,
	className,
	right,
}: {
	children: ReactNode;
	className?: string;
	right?: ReactNode;
}) {
	return (
		<div className={cn("flex min-h-7 items-center gap-2", className)}>
			<h3 className="text-[11px] leading-[14px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
				{children}
			</h3>
			{right ? (
				<div className="ml-auto flex items-center gap-1">{right}</div>
			) : null}
		</div>
	);
}

const AMOUNT = /((?:[A-Z]{1,2}\$|[¥$€£₩₫₺]|−|-)*\d[\d,.]*[KMB]?)/;

/**
 * Text with only its numbers in mono ("¥10K of ¥60K", "¥400 left"): DESIGN
 * sets amounts in mono tabular figures, never the words around them.
 */
export function MonoNumbers({ text }: { text: string }) {
	const parts = text.split(AMOUNT);
	return (
		<>
			{parts.map((p, i) =>
				i % 2 === 1 ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: split parts are positional
					<Num key={i}>{p}</Num>
				) : (
					p
				),
			)}
		</>
	);
}

/** "Planned", "¥10k of ¥60k", "Paid" (never dashed: ADDENDUM §10). */
export function statusText(e: ExpenseDto): string {
	if (e.amountMinor === null || !e.currency)
		return e.payments.length ? "Booked" : "Planned";
	if (e.status === "planned")
		return e.expectedOn ? `Planned · ${shortDate(e.expectedOn)}` : "Planned";
	if (e.status === "partial") {
		const paid = paidInCurrency(e);
		if (paid !== null)
			return `${formatMoneyShort(paid, e.currency)} of ${formatMoneyShort(e.amountMinor, e.currency)}`;
		return "Part paid";
	}
	return "Paid";
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** "5 Oct" from `YYYY-MM-DD`. */
export function shortDate(d: string): string {
	const [y, m, day] = d.split("-").map(Number);
	if (!y || !m || !day) return d;
	return `${day} ${MONTHS[m - 1]}`;
}

/** "4 Oct" in the payment's zone. */
export function paidDate(iso: string, tz: string): string {
	try {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(new Date(iso));
		return shortDate(parts);
	} catch {
		return shortDate(iso.slice(0, 10));
	}
}

export function signed(minor: number, currency: string): string {
	const s = formatMoney(Math.abs(minor), currency);
	return minor > 0 ? `+${s}` : minor < 0 ? `−${s}` : s;
}
