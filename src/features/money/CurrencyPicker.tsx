/**
 * A searchable currency picker: suggested codes first (home, the place's
 * currency, the trip's currencies), then every ISO 4217 code the runtime
 * knows, with its name ("JPY · Japanese yen").
 */
import { cn } from "cn";
import { Check, ChevronDown } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { currencySymbol } from "@/lib/engine/money";

const COMMON = [
	"USD",
	"CAD",
	"EUR",
	"GBP",
	"JPY",
	"KRW",
	"TWD",
	"VND",
	"TRY",
	"CNY",
	"HKD",
	"THB",
	"SGD",
	"AUD",
	"MXN",
	"CHF",
];

let ALL: string[] | null = null;
function allCodes(): string[] {
	if (!ALL) {
		try {
			ALL = (
				Intl as unknown as { supportedValuesOf(k: string): string[] }
			).supportedValuesOf("currency");
		} catch {
			ALL = COMMON;
		}
	}
	return ALL;
}

let NAMES: Intl.DisplayNames | null = null;
export function currencyName(code: string): string {
	try {
		NAMES ??= new Intl.DisplayNames(["en"], { type: "currency" });
		return NAMES.of(code) ?? code;
	} catch {
		return code;
	}
}

export function CurrencyPicker({
	value,
	onChange,
	suggested = [],
	disabled,
	trigger,
	className,
	testid,
	extra,
}: {
	value: string;
	onChange: (code: string) => void;
	suggested?: readonly string[];
	disabled?: boolean;
	trigger?: ReactNode;
	className?: string;
	testid?: string;
	/** Extra items on top ("Local"). */
	extra?: { value: string; label: string; hint?: string }[];
}) {
	const [open, setOpen] = useState(false);
	const top = useMemo(
		() => [...new Set([...suggested, ...COMMON])],
		[suggested],
	);
	const rest = useMemo(() => allCodes().filter((c) => !top.includes(c)), [top]);
	const pick = (c: string) => {
		onChange(c);
		setOpen(false);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild disabled={disabled}>
				{trigger ?? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						data-testid={testid}
						aria-label={`Currency: ${value}`}
						className={cn("gap-1 font-mono tnum", className)}
					>
						{value}
						<ChevronDown className="size-3.5 opacity-60" />
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent className="w-64 p-0" align="start">
				<Command>
					<CommandInput placeholder="Search currencies…" />
					<CommandList className="max-h-72">
						<CommandEmpty>No matches.</CommandEmpty>
						{extra?.length ? (
							<CommandGroup>
								{extra.map((x) => (
									<CommandItem
										key={x.value}
										className="cursor-pointer"
										value={`${x.value} ${x.label}`}
										onSelect={() => pick(x.value)}
									>
										<span className="flex-1">{x.label}</span>
										{x.hint ? (
											<span className="text-xs text-muted-foreground">
												{x.hint}
											</span>
										) : null}
										{value === x.value ? <Check className="size-4" /> : null}
									</CommandItem>
								))}
							</CommandGroup>
						) : null}
						<CommandGroup heading="Suggested">
							{top.map((c) => (
								<CurrencyItem
									key={c}
									code={c}
									selected={c === value}
									onSelect={pick}
								/>
							))}
						</CommandGroup>
						<CommandGroup heading="All currencies">
							{rest.map((c) => (
								<CurrencyItem
									key={c}
									code={c}
									selected={c === value}
									onSelect={pick}
								/>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function CurrencyItem({
	code,
	selected,
	onSelect,
}: {
	code: string;
	selected: boolean;
	onSelect: (c: string) => void;
}) {
	const name = currencyName(code);
	return (
		<CommandItem
			className="cursor-pointer"
			value={`${code} ${name}`}
			onSelect={() => onSelect(code)}
		>
			<span className="w-10 font-mono text-xs tnum">{code}</span>
			<span className="flex-1 truncate">{name}</span>
			<span className="text-xs text-muted-foreground">
				{currencySymbol(code)}
			</span>
			{selected ? <Check className="size-4" /> : null}
		</CommandItem>
	);
}
