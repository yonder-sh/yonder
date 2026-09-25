import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DISPLAY_PREFS, setDisplayPrefs } from "@/lib/format";
import { DurationInput, parseTimeInput, TimeInput, TimeText } from "./time";

describe("parseTimeInput (24-hour TimeInput)", () => {
	it("accepts only complete times while typing", () => {
		expect(parseTimeInput("10:30")).toBe("10:30");
		expect(parseTimeInput("9:05")).toBe("09:05");
		expect(parseTimeInput("0930")).toBe("09:30");
		expect(parseTimeInput("10")).toBeNull();
		expect(parseTimeInput("10:3")).toBeNull();
		expect(parseTimeInput("24:00")).toBeNull();
	});

	it("accepts loose forms on blur", () => {
		expect(parseTimeInput("9", { loose: true })).toBe("09:00");
		expect(parseTimeInput("930", { loose: true })).toBe("09:30");
		expect(parseTimeInput("5pm", { loose: true })).toBe("17:00");
		expect(parseTimeInput("12:15 am", { loose: true })).toBe("00:15");
		expect(parseTimeInput("13pm", { loose: true })).toBeNull();
	});
});

describe("TimeInput", () => {
	it("is a text field that emits complete HH:mm values and steps with arrows", () => {
		const onChange = vi.fn();
		render(<TimeInput value="09:00" onChange={onChange} aria-label="Start" />);
		const input = screen.getByLabelText("Start") as HTMLInputElement;
		expect(input.type).toBe("text");
		fireEvent.change(input, { target: { value: "17" } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "17:30" } });
		expect(onChange).toHaveBeenLastCalledWith("17:30");
		fireEvent.keyDown(input, { key: "ArrowUp" });
		expect(onChange).toHaveBeenLastCalledWith("17:45");
	});

	it("reverts an invalid entry on blur", () => {
		const onChange = vi.fn();
		render(<TimeInput value="09:00" onChange={onChange} aria-label="Start" />);
		const input = screen.getByLabelText("Start") as HTMLInputElement;
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "99:99" } });
		expect(input.getAttribute("aria-invalid")).toBe("true");
		fireEvent.blur(input);
		expect(input.value).toBe("09:00");
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("TimeText follows the 12/24 h setting", () => {
	afterEach(() => setDisplayPrefs(DEFAULT_DISPLAY_PREFS));
	it("re-renders when the viewer switches", () => {
		render(<TimeText date={Date.UTC(2027, 9, 5, 8, 5)} tz="Asia/Tokyo" />);
		expect(screen.getByText("17:05")).toBeTruthy();
		act(() => setDisplayPrefs({ clock: "12h" }));
		expect(screen.getByText("5:05pm")).toBeTruthy();
	});
});

describe("DurationInput", () => {
	it("QA TL-02: opens with the typed field focused, so '3h' + Enter sets 3h (not the first preset)", async () => {
		const onChange = vi.fn();
		render(<DurationInput value={150} onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: "2h30" }));
		const field = (await screen.findByLabelText(
			"Duration",
		)) as HTMLInputElement;
		expect(document.activeElement).toBe(field);
		expect(field.value).toBe("2h30");
		fireEvent.change(field, { target: { value: "3h" } });
		fireEvent.submit(field.closest("form") as HTMLFormElement);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(180);
	});
});
