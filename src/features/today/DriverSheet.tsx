/**
 * "Show this to the driver" (board P16): the place's local name and its
 * address in local script, very large, over the whole screen; then the
 * English name and address, Copy and Directions. The local address is looked
 * up when it opens (`useLocalAddress`); without one, the local name and the
 * address the place has.
 */
import { Copy, Navigation, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { GraphNode } from "@/lib/engine/types";
import { langFor } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { directionsUrl, type TravelBy } from "./lib/directions";
import { useLocalAddress } from "./mutations";
import { TODAY_TESTID } from "./testids";

export function DriverSheet({
	node,
	by,
	onClose,
}: {
	/** The place (null: closed). */
	node: GraphNode | null;
	by: TravelBy;
	onClose: () => void;
}) {
	return (
		<Sheet open={node !== null} onOpenChange={(o) => !o && onClose()}>
			<SheetContent
				side="bottom"
				showCloseButton={false}
				aria-describedby={undefined}
				data-testid={TODAY_TESTID.driver}
				className="h-svh gap-0 border-t-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
			>
				{node ? <DriverCard node={node} by={by} onClose={onClose} /> : null}
			</SheetContent>
		</Sheet>
	);
}

function DriverCard({
	node,
	by,
	onClose,
}: {
	node: GraphNode;
	by: TravelBy;
	onClose: () => void;
}) {
	const { graph, mode, ix } = useWorkspace();
	const { localAddress, loading } = useLocalAddress(
		graph.trip.id,
		node,
		mode === "live",
	);
	const lang = langFor(
		node.countryCode ??
			ix.path(node.id).find((n) => n.type === "country")?.countryCode,
	);
	const bigName = node.localName ?? node.name;
	// No local address (yet): the address the place has, large.
	const bigAddress = localAddress ?? (loading ? null : node.address);
	const english = [
		node.name !== bigName ? node.name : null,
		localAddress ? node.address : null,
	];
	const coord = ix.coordOf(node.id);
	const copy = async () => {
		const text = [bigName, bigAddress].filter(Boolean).join("\n");
		try {
			await navigator.clipboard.writeText(text);
			toast("Address copied");
		} catch {
			toast.error("Couldn't copy the address");
		}
	};
	return (
		<div className="mx-auto flex h-full w-full max-w-xl flex-col px-5">
			<div className="flex h-14 shrink-0 items-center gap-2">
				<Button
					variant="ghost"
					size="icon"
					aria-label="Close"
					onClick={onClose}
					className="-ml-2"
				>
					<X className="size-5" />
				</Button>
				<SheetTitle className="flex-1 pr-10 text-center text-sm font-normal text-muted-foreground">
					Show this to the driver
				</SheetTitle>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto pt-8 pb-6">
				<div
					lang={lang}
					data-testid={TODAY_TESTID.driverLocal}
					className="grid gap-4 border-b pb-8"
				>
					<p className="font-display text-4xl leading-tight font-bold break-words">
						{bigName}
					</p>
					{bigAddress ? (
						<p className="font-display text-3xl leading-snug font-bold break-words">
							{bigAddress}
						</p>
					) : loading ? (
						<p className="text-body text-muted-foreground">
							Looking up the address…
						</p>
					) : null}
				</div>
				{english.some(Boolean) ? (
					<div className="grid gap-1 pt-6">
						{english[0] ? (
							<p className="text-body font-semibold">{english[0]}</p>
						) : null}
						{english[1] ? (
							<p className="text-sm text-muted-foreground">{english[1]}</p>
						) : null}
					</div>
				) : null}
			</div>
			<div className="flex shrink-0 gap-3 pt-3 pb-5">
				<Button
					variant="outline"
					size="xl"
					onClick={() => void copy()}
					data-testid={TODAY_TESTID.driverCopy}
				>
					<Copy />
					Copy
				</Button>
				{coord ? (
					<Button asChild size="xl" className="flex-1">
						<a
							href={directionsUrl(coord, by)}
							target="_blank"
							rel="noopener noreferrer"
							data-testid={TODAY_TESTID.driverDirections}
						>
							<Navigation />
							Directions
						</a>
					</Button>
				) : null}
			</div>
		</div>
	);
}
