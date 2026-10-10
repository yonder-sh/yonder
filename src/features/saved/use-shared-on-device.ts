import { useEffect, useState } from "react";
import { SHARED_CHANGED } from "@/features/home/use-shortcut-pickup";
import { listShared, type SharedEntry } from "@/features/offline/share-store";

/** Shares kept on this device (`yonder-share`), re-read when they change. */
export function useSharedOnDevice(): SharedEntry[] {
	const [list, setList] = useState<SharedEntry[]>([]);
	useEffect(() => {
		const read = () => void listShared().then(setList);
		read();
		window.addEventListener(SHARED_CHANGED, read);
		return () => window.removeEventListener(SHARED_CHANGED, read);
	}, []);
	return list;
}
