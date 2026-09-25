/**
 * Provider marks for social tiles (DESIGN §7.2: 14px, white on black 60%).
 * Simple monochrome shapes of our own (lucide has no brand icons); the
 * provider name is always in the accessible label.
 */
import { cn } from "cn";
import { FileText, Globe, Play } from "lucide-react";
import { providerLabel } from "../embeds";

function YouTubeMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
			<rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor" />
			<path d="M10 9.2v5.6l4.8-2.8z" fill="#000" opacity=".75" />
		</svg>
	);
}

function TikTokMark({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			className={className}
			fill="none"
			stroke="currentColor"
			strokeWidth="2.2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5" />
			<path d="M14 3c.4 2.6 2.2 4.4 5 4.6" />
		</svg>
	);
}

function InstagramMark({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			className={className}
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
		>
			<rect x="3.5" y="3.5" width="17" height="17" rx="5" />
			<circle cx="12" cy="12" r="4" />
			<circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" />
		</svg>
	);
}

export function ProviderMark({
	provider,
	className,
}: {
	provider: string | null;
	className?: string;
}) {
	const c = cn("size-3.5", className);
	switch (provider) {
		case "youtube":
			return <YouTubeMark className={c} />;
		case "tiktok":
			return <TikTokMark className={c} />;
		case "instagram":
			return <InstagramMark className={c} />;
		case "pdf":
			return <FileText className={c} strokeWidth={1.75} aria-hidden="true" />;
		case "video":
			return <Play className={c} strokeWidth={1.75} aria-hidden="true" />;
		default:
			return <Globe className={c} strokeWidth={1.5} aria-hidden="true" />;
	}
}

/** The dark pill in a tile's top-left corner. */
export function ProviderBadge({ provider }: { provider: string | null }) {
	return (
		<span
			role="img"
			aria-label={providerLabel(provider)}
			className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-black/60 text-white"
		>
			<ProviderMark provider={provider} />
		</span>
	);
}
