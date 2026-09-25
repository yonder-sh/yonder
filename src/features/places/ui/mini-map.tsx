/**
 * Lazy `MiniMap`: MapLibre loads on first use, client-only. While it loads
 * (or if WebGL is unavailable) a quiet basemap-coloured box with the pin
 * stands in, so the layout never jumps.
 */
import { cn } from "cn";
import {
	Component,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useState,
} from "react";
import { pinStyle } from "@/lib/domain/taxonomy";
import type { MiniMapProps } from "./mini-map.impl";

const Impl = lazy(() => import("./mini-map.impl"));

function Placeholder({ className, type, category, pick }: MiniMapProps) {
	const pin = pinStyle({ type: type ?? "place", category: category ?? null });
	return (
		<div
			className={cn(
				"relative grid place-items-center overflow-hidden bg-basemap-land",
				className,
			)}
		>
			{pick ? null : (
				<span
					aria-hidden="true"
					className="block size-4 rounded-full border-2 border-white shadow-float"
					style={{ backgroundColor: pin.fill }}
				/>
			)}
		</div>
	);
}

class Boundary extends Component<
	{ fallback: ReactNode; children: ReactNode },
	{ failed: boolean }
> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

export function MiniMap(props: MiniMapProps) {
	const [client, setClient] = useState(false);
	useEffect(() => setClient(true), []);
	const fallback = <Placeholder {...props} />;
	if (!client) return fallback;
	return (
		<Boundary fallback={fallback}>
			<Suspense fallback={fallback}>
				<Impl {...props} />
			</Suspense>
		</Boundary>
	);
}

export type { MiniMapProps };
