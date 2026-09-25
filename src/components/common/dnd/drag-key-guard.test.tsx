/**
 * QA A11Y-02: Esc that cancels a keyboard drag must not also run the
 * workspace Esc chain (the hotkeys skip keys that are `defaultPrevented`).
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDragKeyGuard } from "./workspace-dnd";

const seen: { key: string; handled: boolean }[] = [];
const onDoc = (e: KeyboardEvent) =>
	seen.push({ key: e.key, handled: e.defaultPrevented });
document.addEventListener("keydown", onDoc);

function press(key: string) {
	document.body.dispatchEvent(
		new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
	);
	return seen.at(-1);
}

afterEach(() => {
	seen.length = 0;
});

describe("useDragKeyGuard", () => {
	it("marks Esc, Enter and Space handled while a drag runs, and nothing after", () => {
		const { rerender, unmount } = renderHook(
			({ dragging }) => useDragKeyGuard(dragging),
			{ initialProps: { dragging: true } },
		);
		expect(press("Escape")?.handled).toBe(true);
		expect(press("Enter")?.handled).toBe(true);
		expect(press(" ")?.handled).toBe(true);
		expect(press("ArrowDown")?.handled).toBe(false);
		rerender({ dragging: false });
		expect(press("Escape")?.handled).toBe(false);
		unmount();
	});
});
