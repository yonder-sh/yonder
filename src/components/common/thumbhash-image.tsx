/**
 * An image that shows its thumbhash placeholder until it loads (SPEC §12.6).
 * The placeholder is decoded once per hash.
 */
import { cn } from "cn";
import { useMemo, useState } from "react";
import { thumbHashToDataURL } from "thumbhash";

function decode(hash: string | null | undefined): string | undefined {
	if (!hash) return undefined;
	try {
		const bytes = Uint8Array.from(atob(hash), (c) => c.charCodeAt(0));
		return thumbHashToDataURL(bytes);
	} catch {
		return undefined;
	}
}

export function ThumbhashImage({
	hash,
	src,
	w,
	h,
	alt,
	className,
}: {
	hash?: string | null;
	src: string;
	w?: number | null;
	h?: number | null;
	alt: string;
	className?: string;
}) {
	const placeholder = useMemo(() => decode(hash), [hash]);
	const [loaded, setLoaded] = useState(false);
	return (
		<span
			className={cn("relative block overflow-hidden bg-muted", className)}
			style={{
				aspectRatio: w && h ? `${w} / ${h}` : undefined,
				backgroundImage:
					!loaded && placeholder ? `url(${placeholder})` : undefined,
				backgroundSize: "cover",
			}}
		>
			<img
				src={src}
				alt={alt}
				width={w ?? undefined}
				height={h ?? undefined}
				loading="lazy"
				decoding="async"
				onLoad={() => setLoaded(true)}
				className={cn(
					"size-full object-cover transition-opacity duration-300",
					loaded ? "opacity-100" : "opacity-0",
				)}
			/>
		</span>
	);
}
