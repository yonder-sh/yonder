/**
 * "Show in" (ADDENDUM §7.2): the viewer's display currency — the trip's home
 * currency (default), "Local" (the scope's country currency, else home), or
 * any ISO code. View-only; synced to the account (`setUserPrefs`).
 */
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { currencyForCountry } from "@/lib/domain/currency";
import { scopeCountry } from "@/lib/engine/money-scope";
import { humanError } from "@/lib/errors";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CurrencyPicker } from "./CurrencyPicker";
import { MONEY_TESTID } from "./testids";
import { useDisplayCurrency, useSetDisplayCurrency } from "./use-money";

export function DisplayCurrencyPicker() {
	const { ix, scope, mode } = useWorkspace();
	const d = useDisplayCurrency();
	const set = useSetDisplayCurrency();
	const local = currencyForCountry(scopeCountry(ix, scope?.id ?? null), "");
	const value = d.pref === "local" ? "local" : (d.pref ?? "home");
	const choose = (v: string) => {
		const next = v === "home" ? null : v;
		set.mutate(next, { onError: (e) => toast.error(humanError(e)) });
	};
	return (
		<CurrencyPicker
			value={value}
			onChange={choose}
			disabled={mode !== "live"}
			suggested={[d.home, ...(local ? [local] : [])]}
			extra={[
				{ value: "home", label: `Home currency`, hint: d.home },
				{
					value: "local",
					label: "Local",
					hint: local ? `${local} here` : "in a country",
				},
			]}
			trigger={
				<Button
					variant="ghost"
					size="sm"
					className="h-8 gap-1 px-2 text-xs text-muted-foreground"
					data-testid={MONEY_TESTID.displayCurrency}
					aria-label={`Show amounts in ${d.code}`}
				>
					Show in{" "}
					<span className="font-mono text-foreground tnum">
						{d.pref === "local" ? `Local · ${d.code}` : d.code}
					</span>
					<ChevronDown className="size-3.5 opacity-60" />
				</Button>
			}
		/>
	);
}
