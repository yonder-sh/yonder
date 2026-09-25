/**
 * An upload in flight (DESIGN §7.2): the local preview (or the document
 * icon), a 28px progress ring in primary with the percentage in 11px mono,
 * Cancel; a failed one keeps its tile with the reason and Retry (MED-08).
 */
import { AlertCircle, FileText, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MEDIA_TESTID } from "../testids";
import type { UploadItem } from "../upload/uploader";

function Ring({ value }: { value: number }) {
	const r = 12;
	const c = 2 * Math.PI * r;
	return (
		<span
			className="relative grid size-7 place-items-center"
			role="progressbar"
			aria-valuenow={Math.round(value * 100)}
			aria-valuemin={0}
			aria-valuemax={100}
		>
			<svg
				viewBox="0 0 28 28"
				className="absolute inset-0 -rotate-90"
				aria-hidden="true"
			>
				<circle
					cx="14"
					cy="14"
					r={r}
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					className="text-white/40"
				/>
				<circle
					cx="14"
					cy="14"
					r={r}
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeDasharray={c}
					strokeDashoffset={c * (1 - value)}
					className="text-primary transition-[stroke-dashoffset] duration-200"
				/>
			</svg>
		</span>
	);
}

export function UploadTile({
	item,
	onCancel,
	onRetry,
	onDismiss,
}: {
	item: UploadItem;
	onCancel: () => void;
	onRetry: () => void;
	onDismiss: () => void;
}) {
	const failed = item.phase === "failed";
	const pct = Math.round(item.progress * 100);
	const aspect =
		item.width && item.height ? `${item.width} / ${item.height}` : "4 / 3";
	return (
		<figure
			data-testid={MEDIA_TESTID.uploadTile}
			data-phase={item.phase}
			className="relative mb-2 break-inside-avoid"
		>
			<div
				className="relative overflow-hidden rounded-lg bg-muted"
				style={{ aspectRatio: aspect }}
			>
				{item.previewUrl && item.kind === "photo" ? (
					<img
						src={item.previewUrl}
						alt=""
						className="absolute inset-0 size-full object-cover opacity-70"
					/>
				) : item.previewUrl && item.kind === "video" ? (
					<video
						src={item.previewUrl}
						muted
						playsInline
						preload="metadata"
						className="absolute inset-0 size-full object-cover opacity-70"
					/>
				) : (
					<span className="absolute inset-0 grid place-items-center">
						<FileText
							className="size-8 text-muted-foreground/60"
							strokeWidth={1.25}
						/>
					</span>
				)}
				{failed ? (
					<span className="absolute inset-0 flex flex-col items-center justify-center gap-2 border border-dashed border-border bg-background p-3 text-center">
						<AlertCircle
							className="size-4 text-muted-foreground"
							strokeWidth={1.75}
						/>
						<span className="line-clamp-3 text-xs text-foreground">
							{item.error}
						</span>
						<span className="flex gap-1">
							{item.retryable ? (
								<Button
									size="xs"
									variant="outline"
									onClick={onRetry}
									data-testid={MEDIA_TESTID.uploadRetry}
								>
									<RotateCcw /> Retry
								</Button>
							) : null}
							<Button size="xs" variant="ghost" onClick={onDismiss}>
								Dismiss
							</Button>
						</span>
					</span>
				) : (
					<span className="absolute inset-0 grid place-items-center">
						<span className="flex flex-col items-center gap-1 rounded-xl bg-black/45 px-3 py-2 text-white backdrop-blur-sm">
							<Ring value={item.phase === "preparing" ? 0 : item.progress} />
							<span className="font-mono text-[11px] tnum">
								{item.phase === "preparing"
									? "…"
									: item.phase === "finishing"
										? "Saving"
										: `${pct}%`}
							</span>
						</span>
					</span>
				)}
				{!failed ? (
					<button
						type="button"
						onClick={onCancel}
						aria-label={`Cancel ${item.name}`}
						data-testid={MEDIA_TESTID.uploadCancel}
						className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-black/55 text-white hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-ring"
					>
						<X className="size-3.5" />
					</button>
				) : null}
			</div>
			<figcaption className="mt-1 truncate px-0.5 text-xs text-muted-foreground">
				{item.name}
			</figcaption>
		</figure>
	);
}
