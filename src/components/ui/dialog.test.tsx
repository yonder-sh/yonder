/** A toast's Undo over a modal dialog never counts as a click away (e2e: outline-tree's Undo). */
import { describe, expect, it } from "vitest";
import { keepToastClicks } from "./dialog";

function outsideEvent(target: Element): Event {
	const e = new CustomEvent("dismissableLayer.pointerDownOutside", {
		cancelable: true,
	});
	Object.defineProperty(e, "target", { value: target });
	return e;
}

describe("keepToastClicks", () => {
	it("keeps the dialog open for a click on a toast, not for one elsewhere", () => {
		document.body.innerHTML =
			'<ol data-sonner-toaster><li data-sonner-toast><button id="undo">Undo</button></li></ol><button id="away">Away</button>';
		const onToast = outsideEvent(document.getElementById("undo") as Element);
		keepToastClicks(onToast);
		expect(onToast.defaultPrevented).toBe(true);
		const away = outsideEvent(document.getElementById("away") as Element);
		keepToastClicks(away);
		expect(away.defaultPrevented).toBe(false);
	});
});
