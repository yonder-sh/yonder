/**
 * Lazy `ResultsMap`: MapLibre loads on first use, client-only; the quiet
 * basemap colour stands in while it loads or without WebGL.
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
import type { ResultsMapProps } from "./results-map.impl";

const Impl = lazy(() => import("./results-map.impl"));

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

export function ResultsMap(props: ResultsMapProps) {
	const [client, setClient] = useState(false);
	useEffect(() => setClient(true), []);
	const fallback = <div className={cn("bg-basemap-land", props.className)} />;
	if (!client) return fallback;
	return (
		<Boundary fallback={fallback}>
			<Suspense fallback={fallback}>
				<Impl {...props} />
			</Suspense>
		</Boundary>
	);
}

export type { ResultPin } from "./results-map.impl";
