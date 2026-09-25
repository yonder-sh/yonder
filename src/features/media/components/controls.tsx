/**
 * Media header controls (DESIGN §7.2): the filter chips (All · Photos ·
 * Videos · Social · Guides · Documents), the Add button (upload, or paste a
 * link) and the drop overlay.
 */
import { cn } from "cn";
import { Link2, Plus, Upload } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { humanError } from "@/lib/errors";
import { classifyUrl, providerLabel } from "../embeds";
import {
	FILTER_LABEL,
	IMAGE_TYPES,
	type MediaFilter,
	PDF_TYPE,
	UPLOAD_EDIT_ONLY_REASON,
	VIDEO_TYPES,
} from "../media-kinds";
import { MEDIA_TESTID } from "../testids";
import { EscapeOwner } from "./use-escape-owner";

export function FilterChips({
	value,
	onChange,
	available,
	className,
}: {
	value: MediaFilter | null;
	onChange: (v: MediaFilter | null) => void;
	/** Filters with something in view (the active one always shows). */
	available: ReadonlySet<MediaFilter>;
	className?: string;
}) {
	const chips: (MediaFilter | null)[] = [
		null,
		...(["photos", "videos", "social", "guides", "documents"] as const).filter(
			(f) => available.has(f) || value === f,
		),
	];
	if (chips.length <= 2 && value === null) return <div className={className} />;
	return (
		<div
			role="toolbar"
			aria-label="Show"
			className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
		>
			{chips.map((f) => {
				const active = value === f;
				return (
					<button
						key={f ?? "all"}
						type="button"
						aria-pressed={active}
						data-testid={MEDIA_TESTID.filterChip}
						data-filter={f ?? "all"}
						onClick={() => onChange(f)}
						className={cn(
							"h-[22px] rounded-full px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
							active
								? "bg-foreground text-background"
								: "bg-muted text-muted-foreground hover:text-foreground",
						)}
					>
						{FILTER_LABEL[f ?? "all"]}
					</button>
				);
			})}
		</div>
	);
}

const ACCEPT = [
	...IMAGE_TYPES,
	...VIDEO_TYPES,
	PDF_TYPE,
	".heic",
	".heif",
	"image/heic",
	"image/heif",
].join(",");

export function AddMediaButton({
	onFiles,
	onLink,
	compact,
}: {
	onFiles: (files: FileList) => void;
	onLink: (url: string) => Promise<boolean>;
	compact?: boolean;
}) {
	const upload = useEditGuard("edit-only", UPLOAD_EDIT_ONLY_REASON);
	const link = useEditGuard();
	const input = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const disabled = upload.disabled && link.disabled;
	const kind = (() => {
		try {
			const c = classifyUrl(new URL(url.trim()).href);
			return c.kind === "embed" ? providerLabel(c.provider) : "Web page";
		} catch {
			return null;
		}
	})();

	async function submit(e: FormEvent) {
		e.preventDefault();
		let href: string;
		try {
			const u = new URL(url.trim());
			if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
			href = u.href;
		} catch {
			setError("That isn't a web link. Paste one that starts with https://");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			if (await onLink(href)) {
				setOpen(false);
				setUrl("");
			}
		} catch (err) {
			setError(humanError(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<input
				ref={input}
				type="file"
				multiple
				accept={ACCEPT}
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				data-testid={MEDIA_TESTID.fileInput}
				onChange={(e) => {
					if (e.target.files?.length) onFiles(e.target.files);
					e.target.value = "";
				}}
			/>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size={compact ? "xs" : "sm"}
						disabled={disabled}
						title={disabled ? (link.reason ?? undefined) : undefined}
						data-testid={MEDIA_TESTID.addButton}
					>
						<Plus /> Add
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-60">
					<DropdownMenuItem
						data-testid={MEDIA_TESTID.addUpload}
						disabled={upload.disabled}
						title={upload.disabled ? (upload.reason ?? undefined) : undefined}
						onSelect={() => input.current?.click()}
					>
						<Upload /> Photos, videos or PDFs…
					</DropdownMenuItem>
					<DropdownMenuItem
						data-testid={MEDIA_TESTID.addLink}
						disabled={link.disabled}
						title={link.disabled ? (link.reason ?? undefined) : undefined}
						onSelect={() => {
							setError(null);
							setOpen(true);
						}}
					>
						<Link2 /> A link…
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-md">
					{open ? <EscapeOwner onEscape={() => setOpen(false)} /> : null}
					<DialogHeader>
						<DialogTitle>Add a link</DialogTitle>
						<DialogDescription>
							A guide, a menu, a YouTube video, a TikTok or a Reel.
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={submit} className="grid gap-3">
						<Input
							data-testid={MEDIA_TESTID.linkInput}
							value={url}
							onChange={(e) => {
								setUrl(e.target.value);
								setError(null);
							}}
							placeholder="https://www.japan-guide.com/e/e2172.html"
							inputMode="url"
							autoFocus
							aria-invalid={!!error}
						/>
						<p
							className="min-h-4 text-xs text-muted-foreground"
							aria-live="polite"
						>
							{error ? (
								<span className="text-destructive">{error}</span>
							) : kind ? (
								<>
									Adds a {kind === "Web page" ? "link card" : `${kind} card`}.
								</>
							) : null}
						</p>
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={busy || !url.trim()}
								data-testid={MEDIA_TESTID.linkSubmit}
							>
								Add link
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

export function DropOverlay({ label }: { label: string }) {
	return (
		<div
			data-testid={MEDIA_TESTID.dropOverlay}
			className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-lg border-2 border-dashed border-primary/40 bg-primary/5"
		>
			<span className="rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-float">
				{label}
			</span>
		</div>
	);
}
