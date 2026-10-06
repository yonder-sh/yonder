/**
 * Suspense for a lazy part that also catches its chunk failing to load
 * (offline, or the precache left it out): the fallback stays, so the error
 * never reaches the route's error page or its reload. Other errors pass on.
 */
import { Component, type ReactNode, Suspense } from "react";

const CHUNK_ERROR =
	/dynamically imported module|Importing a module script failed|Loading (CSS )?chunk \d+ failed/i;

/** A lazy import that never arrived. */
export function isChunkError(e: unknown): boolean {
	return e instanceof Error && CHUNK_ERROR.test(e.message);
}

export class LazySlot extends Component<
	{ fallback: ReactNode; children: ReactNode },
	{ error: unknown }
> {
	state = { error: null as unknown };

	static getDerivedStateFromError(error: unknown) {
		return { error };
	}

	render() {
		const { error } = this.state;
		if (error !== null) {
			if (!isChunkError(error)) throw error;
			return this.props.fallback;
		}
		return (
			<Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>
		);
	}
}
