import { cn } from "cn";

/**
 * The Yonder mark (brand/logo/yonder-mark*.svg): the forked route in
 * `currentColor` and the apricot "yonder point" (`--glow`). Never close the
 * gap between the route and the dot (BRAND.md).
 */
export function YonderMark({
	className,
	title = "Yonder",
	mono = false,
}: {
	className?: string;
	title?: string;
	/** Draw the dot in currentColor too (tiny sizes, one-colour contexts). */
	mono?: boolean;
}) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="10.7 7.9 29.6 32.4"
			role="img"
			aria-label={title}
			className={cn("size-5 shrink-0", className)}
		>
			<title>{title}</title>
			<path
				d="M13 12C13 19 24 19 24 27L24 38M24 27C24 21.5 28 18.5 30.5 16.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="4.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle
				cx="36.6"
				cy="11.6"
				r="3.7"
				fill={mono ? "currentColor" : "var(--glow)"}
			/>
		</svg>
	);
}
