/**
 * A social embed (SPEC §15.3, SECURITY §7): the iframe `src` is built from the
 * stored provider + id only; sandboxed, lazy, no top navigation. A plain link
 * under it always works when the embed is blocked (offline, CSP, a private
 * post) — MED-04.
 */
import { ExternalLink } from "lucide-react";
import { embedSrc, providerLabel } from "../embeds";
import { MEDIA_TESTID } from "../testids";
import type { MediaDto } from "../types";
import { openHref } from "./media-tile";

export function EmbedFrame({
	item,
	autoplay = false,
	maxHeight = "80vh",
}: {
	item: MediaDto;
	autoplay?: boolean;
	maxHeight?: string;
}) {
	const src = embedSrc(item.provider, item.embedId, {
		igType: item.igType,
		autoplay,
	});
	const aspect = item.aspect ?? (item.provider === "youtube" ? 16 / 9 : 9 / 16);
	const href = openHref(item);
	const label = providerLabel(item.provider);
	return (
		<div className="flex w-full flex-col items-center gap-3">
			{src ? (
				<div
					className="relative overflow-hidden rounded-xl bg-black shadow-float"
					style={{
						aspectRatio: String(aspect),
						height: aspect < 1 ? `min(${maxHeight}, 760px)` : undefined,
						width:
							aspect >= 1
								? `min(92vw, calc(${maxHeight} * ${aspect}), 1100px)`
								: undefined,
						maxWidth: "92vw",
					}}
				>
					<iframe
						data-testid={MEDIA_TESTID.embedFrame}
						src={src}
						title={item.title ?? `${label} video`}
						className="absolute inset-0 size-full border-0"
						sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
						allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
						referrerPolicy="strict-origin-when-cross-origin"
						loading="lazy"
					/>
				</div>
			) : (
				<div className="grid aspect-[9/16] h-[min(60vh,560px)] place-items-center rounded-xl bg-white/5 px-6 text-center text-sm text-white/80">
					This {label} post can't be embedded yet.
				</div>
			)}
			{href ? (
				<a
					href={href}
					target="_blank"
					rel="noopener noreferrer nofollow"
					className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[13px] font-medium text-white/90 hover:bg-white/20 hover:text-white"
				>
					Open on {label} <ExternalLink className="size-3.5" />
				</a>
			) : null}
		</div>
	);
}
