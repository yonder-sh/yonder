/**
 * View settings (ADDENDUM §7.2), synced to the account through `user_prefs`
 * (`useViewPrefs`: localStorage first, the account copy wins once loaded).
 * Every control applies at once; there is no Save. Per person, never per
 * trip, and never visible to anyone else.
 *
 * The display currency is view-only: money math stays in the trip's home
 * currency (WP-Money converts for display). Link guests never see money, so
 * they don't get that row. The map has no row: it follows the app theme,
 * and Satellite is a button on the map itself.
 */
import type { ReactNode } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { mustRedact } from "@/lib/auth/roles";
import { NODE_TYPES } from "@/lib/domain/taxonomy";
import { resolveSettings } from "@/lib/engine/graph-index";
import { LENS_PREF_VALUES, type UserPrefs } from "@/lib/schemas/misc";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";
import { PREF_DEFAULTS, useViewPrefs } from "./view-prefs";

/** Currencies offered besides home and Local (the trip currencies first). */
const CURRENCIES = [
	"USD",
	"CAD",
	"JPY",
	"KRW",
	"VND",
	"TWD",
	"TRY",
	"EUR",
	"GBP",
	"AUD",
] as const;

function Row({
	label,
	hint,
	htmlFor,
	children,
}: {
	label: string;
	hint?: string;
	htmlFor?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-11 items-center gap-4 border-b py-2 last:border-b-0">
			<div className="min-w-0 flex-1">
				<label htmlFor={htmlFor} className="block text-sm font-medium">
					{label}
				</label>
				{hint ? (
					<p className="text-xs text-muted-foreground text-pretty">{hint}</p>
				) : null}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

function Segments<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T;
	options: { value: T; label: string }[];
	onChange(v: T): void;
	label: string;
}) {
	return (
		<ToggleGroup
			type="single"
			variant="outline"
			size="sm"
			value={value}
			// A click on the selected segment sends "": it keeps (and saves) that
			// choice, e.g. a map style that only followed the app theme until now.
			onValueChange={(v) => onChange((v || value) as T)}
			aria-label={label}
			className="h-8"
		>
			{options.map((o) => (
				<ToggleGroupItem
					key={o.value}
					value={o.value}
					className="h-8 px-3 text-xs data-[state=on]:bg-foreground data-[state=on]:text-background"
				>
					{o.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}

export function ViewSettingsDialog() {
	const open = useShell((s) => s.viewSettingsOpen);
	const setOpen = useShell((s) => s.setViewSettingsOpen);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				data-testid={SHELL_TESTID.viewSettingsDialog}
				className="sm:max-w-[480px]"
			>
				<DialogHeader>
					<DialogTitle>View settings</DialogTitle>
					<DialogDescription>
						Just for you, on every device you sign in on.
					</DialogDescription>
				</DialogHeader>
				{open ? <Body /> : null}
			</DialogContent>
		</Dialog>
	);
}

function Body() {
	const { graph, mode } = useWorkspace();
	const { prefs, setPrefs } = useViewPrefs({ enabled: mode === "live" });
	const set = (patch: UserPrefs) => setPrefs(patch);
	const home = resolveSettings(graph.trip).currency;
	const guest = mustRedact(graph.me);
	const currency = prefs.displayCurrency ?? "home";
	return (
		<div className="-mt-1">
			<Row
				label="Start at"
				hint="The lens a trip opens with when the link doesn't say."
				htmlFor="pref-lens"
			>
				<Select
					value={prefs.defaultLens ?? "auto"}
					onValueChange={(v) =>
						set({
							defaultLens:
								v === "auto" ? null : (v as (typeof LENS_PREF_VALUES)[number]),
						})
					}
				>
					<SelectTrigger id="pref-lens" size="sm" className="w-36">
						<SelectValue />
					</SelectTrigger>
					<SelectContent align="end">
						<SelectItem value="auto">Automatic</SelectItem>
						{LENS_PREF_VALUES.map((l) => (
							<SelectItem key={l} value={l}>
								{NODE_TYPES[l].label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Row>
			<Row
				label="Compact plan"
				hint="Shorter cards, more of the day on screen."
				htmlFor="pref-compact"
			>
				<Switch
					id="pref-compact"
					checked={prefs.compact ?? PREF_DEFAULTS.compact}
					onCheckedChange={(v) => set({ compact: v })}
				/>
			</Row>
			{mode === "live" ? (
				<Row
					label="Show others' cursors"
					hint="Where people on the same place are pointing. Yours is always shared."
					htmlFor="pref-cursors"
				>
					<Switch
						id="pref-cursors"
						data-testid={SHELL_TESTID.showCursorsSwitch}
						checked={prefs.hideCursors !== true}
						onCheckedChange={(v) => set({ hideCursors: !v })}
					/>
				</Row>
			) : null}
			<Row label="Times" hint="Always in each place's own time zone.">
				<Segments
					label="Clock"
					value={prefs.clock ?? PREF_DEFAULTS.clock}
					onChange={(v) => set({ clock: v })}
					options={[
						{ value: "24h", label: "24-hour" },
						{ value: "12h", label: "12-hour" },
					]}
				/>
			</Row>
			<Row label="Distances">
				<Segments
					label="Distance units"
					value={prefs.units ?? PREF_DEFAULTS.units}
					onChange={(v) => set({ units: v })}
					options={[
						{ value: "km", label: "km" },
						{ value: "mi", label: "mi" },
					]}
				/>
			</Row>
			{guest ? null : (
				<Row
					label="Show money in"
					hint="Only how amounts look to you. Totals and balances stay in the trip's currency."
					htmlFor="pref-currency"
				>
					<Select
						value={currency}
						onValueChange={(v) =>
							set({ displayCurrency: v === "home" ? null : v })
						}
					>
						<SelectTrigger id="pref-currency" size="sm" className="w-36">
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="end">
							<SelectItem value="home">Trip ({home})</SelectItem>
							<SelectItem value="local">Local</SelectItem>
							{CURRENCIES.filter((c) => c !== home).map((c) => (
								<SelectItem key={c} value={c}>
									{c}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Row>
			)}
		</div>
	);
}
