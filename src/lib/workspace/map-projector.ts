/**
 * The map's screen projection for the live-cursor layer (FB-17): the map in
 * view (WP-Map's MapLibre canvas, or its no-WebGL fallback sketch) registers
 * how to turn a client point into lng/lat and back, so a cursor over the map
 * travels as coordinates and lands on the same spot on every screen size.
 *
 * One map per page; the latest registration wins. Client coordinates are
 * `clientX/clientY` (viewport pixels).
 */

export type MapProjector = {
	/** The element the map draws in (its box is the map's visible area). */
	readonly container: HTMLElement;
	/** Client point → lng/lat, or null (off the globe). */
	unproject(x: number, y: number): { lng: number; lat: number } | null;
	/** lng/lat → client point (may be outside the container). */
	project(lng: number, lat: number): { x: number; y: number } | null;
	/** Centre the map on lng/lat (an edge arrow's "jump", Follow). */
	easeTo(lng: number, lat: number): void;
};

let current: MapProjector | null = null;
const listeners = new Set<() => void>();

/** Registers the map; returns the unregister function. */
export function registerMapProjector(p: MapProjector): () => void {
	current = p;
	notifyMapMoved();
	return () => {
		if (current === p) {
			current = null;
			notifyMapMoved();
		}
	};
}

export function getMapProjector(): MapProjector | null {
	return current;
}

/** The map moved (pan, zoom, resize): cursors re-project. */
export function notifyMapMoved(): void {
	for (const l of [...listeners]) l();
}

export function onMapMoved(l: () => void): () => void {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
}

let cameraFollowed = false;

/**
 * FB-22: my map mirrors a leader's camera (paused or not). The live-cursor
 * Follow then never pans the map to their cursor: the camera is theirs, or
 * mine while I paused it.
 */
export function setCameraFollowing(v: boolean): void {
	cameraFollowed = v;
}

export function isMapCameraFollowed(): boolean {
	return cameraFollowed;
}
