/**
 * QA LIST-06 on a phone: an autofocused field (a list row being renamed)
 * stays open. On iOS and Android TipTap focuses at once; in development
 * StrictMode then replays the effects, which moves the view out of the page
 * and back, and that blur used to save and close the field.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import MentionInputEditor from "../MentionInputEditor";

const ANDROID =
	"Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

afterEach(() => {
	vi.restoreAllMocks();
});

it("an autofocused field on Android keeps the focus under StrictMode and never blurs", async () => {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
	// Like Chrome: moving the focused element out of its place blurs it.
	const append = Element.prototype.append;
	vi.spyOn(Element.prototype, "append").mockImplementation(function (
		this: Element,
		...nodes
	) {
		const active = document.activeElement;
		if (
			active instanceof HTMLElement &&
			nodes.some((n) => n instanceof Node && n.contains(active))
		)
			active.blur();
		append.apply(this, nodes);
	});
	const onBlur = vi.fn();
	render(
		<StrictMode>
			<QueryClientProvider client={new QueryClient()}>
				<MentionInputEditor
					value="Chopsticks"
					onChange={() => {}}
					onBlur={onBlur}
					autoFocus
					ariaLabel="Edit the text"
				/>
			</QueryClientProvider>
		</StrictMode>,
	);
	const field = await screen.findByLabelText("Edit the text");
	await waitFor(() => expect(field).toHaveFocus());
	await new Promise((r) => setTimeout(r, 50));
	expect(field).toHaveFocus();
	expect(onBlur).not.toHaveBeenCalled();
});
