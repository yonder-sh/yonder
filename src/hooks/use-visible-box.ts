import { useEffect, useState } from "react";

/** The part of the screen the keyboard leaves (the visual viewport). */
export function useVisibleBox(active: boolean) {
	const [box, setBox] = useState<{ top: number; height: number } | null>(null);
	useEffect(() => {
		const vv = typeof window === "undefined" ? null : window.visualViewport;
		if (!active || !vv) return;
		const on = () => setBox({ top: vv.offsetTop, height: vv.height });
		on();
		vv.addEventListener("resize", on);
		vv.addEventListener("scroll", on);
		return () => {
			vv.removeEventListener("resize", on);
			vv.removeEventListener("scroll", on);
		};
	}, [active]);
	return box;
}
