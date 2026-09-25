/**
 * Editing plain fields together (SPEC §10.8): an input keeps its local draft
 * while focused and ignores server updates; if the server value changes
 * meanwhile, `remoteChanged` says who changed it ("Maya changed this · Use
 * theirs"). `save` receives the draft and the `expectedUpdatedAt` captured at
 * focus time.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "@/lib/workspace/ui-store";

export function useDraftField<T>({
	value,
	updatedAt,
	save,
	flashId,
}: {
	value: T;
	updatedAt: string;
	save: (draft: T, expectedUpdatedAt: string) => void | Promise<void>;
	/** Entity id whose flash names the remote editor (items, nodes, days). */
	flashId?: string;
}): {
	draft: T;
	setDraft: (v: T) => void;
	onFocus: () => void;
	onBlur: () => void;
	remoteChanged: { name: string } | null;
	useTheirs: () => void;
} {
	const [draft, setDraft] = useState(value);
	const focused = useRef(false);
	const base = useRef({ value, updatedAt });
	const [remoteChanged, setRemoteChanged] = useState<{ name: string } | null>(
		null,
	);
	const flash = useUi((s) => (flashId ? s.flashes[flashId] : undefined));

	useEffect(() => {
		if (!focused.current) {
			setDraft(value);
			base.current = { value, updatedAt };
			setRemoteChanged(null);
		} else if (updatedAt !== base.current.updatedAt) {
			setRemoteChanged({ name: flash?.name ?? "Someone" });
		}
	}, [value, updatedAt, flash?.name]);

	const onFocus = useCallback(() => {
		focused.current = true;
		base.current = { value, updatedAt };
	}, [value, updatedAt]);

	const onBlur = useCallback(() => {
		focused.current = false;
		setRemoteChanged(null);
		if (!Object.is(draft, base.current.value))
			void save(draft, base.current.updatedAt);
	}, [draft, save]);

	const useTheirs = useCallback(() => {
		setDraft(value);
		base.current = { value, updatedAt };
		setRemoteChanged(null);
	}, [value, updatedAt]);

	return { draft, setDraft, onFocus, onBlur, remoteChanged, useTheirs };
}
