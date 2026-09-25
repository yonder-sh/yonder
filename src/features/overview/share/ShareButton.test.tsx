import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareButton } from "./ShareButton";
import { SHARE_CARD_TESTID as T } from "./testids";

const png = () =>
	new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

let fetchMock: ReturnType<typeof vi.fn>;
let created: string[];

beforeEach(() => {
	created = [];
	fetchMock = vi.fn(
		async () =>
			new Response(png(), {
				status: 200,
				headers: { "Content-Type": "image/png" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	let n = 0;
	vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
		const u = `blob:card-${++n}`;
		created.push(u);
		return u;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Reflect.deleteProperty(navigator, "canShare");
	Reflect.deleteProperty(navigator, "share");
});

describe("ShareButton", () => {
	it("labels the primary and toolbar buttons", () => {
		const { rerender } = render(
			<ShareButton slug="asia-2027" variant="primary" />,
		);
		expect(screen.getByTestId(T.button)).toHaveTextContent("Make a share card");
		rerender(<ShareButton slug="asia-2027" variant="toolbar" />);
		expect(screen.getByTestId(T.button)).toHaveTextContent("Share");
	});

	it("opens the dialog with the story card, loads the square on the toggle, and downloads the one shown", async () => {
		const user = userEvent.setup();
		render(<ShareButton slug="asia-2027" />);
		await user.click(screen.getByTestId(T.button));
		expect(screen.getByTestId(T.dialog)).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledWith(
			"/t/asia-2027/share-card.png?size=story",
			expect.anything(),
		);
		expect(await screen.findByTestId(T.preview)).toHaveAttribute(
			"src",
			"blob:card-1",
		);

		await user.click(screen.getByRole("radio", { name: "Square" }));
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/t/asia-2027/share-card.png?size=square",
			expect.anything(),
		);
		await waitFor(() =>
			expect(screen.getByTestId(T.preview)).toHaveAttribute(
				"src",
				"blob:card-2",
			),
		);

		const clicks: { href: string; download: string }[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			clicks.push({
				href: this.getAttribute("href") ?? "",
				download: this.download,
			});
		});
		await user.click(screen.getByTestId(T.download));
		expect(clicks).toEqual([
			{ href: "blob:card-2", download: "asia-2027-square.png" },
		]);

		// Back to the story: no second fetch.
		await user.click(screen.getByRole("radio", { name: "Story" }));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await user.click(screen.getByTestId(T.download));
		expect(clicks.at(-1)).toEqual({
			href: "blob:card-1",
			download: "asia-2027-story.png",
		});
	});

	it("offers Share… only where files can be shared, and shares the PNG", async () => {
		const user = userEvent.setup();
		const { unmount } = render(<ShareButton slug="asia-2027" />);
		await user.click(screen.getByTestId(T.button));
		await screen.findByTestId(T.preview);
		expect(screen.queryByTestId(T.share)).toBeNull();
		unmount();

		const share = vi.fn(async () => {});
		Object.assign(navigator, {
			canShare: (d: { files?: File[] }) => !!d.files?.length,
			share,
		});
		render(<ShareButton slug="asia-2027" />);
		await user.click(screen.getByTestId(T.button));
		await user.click(await screen.findByTestId(T.share));
		const files = (share.mock.calls[0] as unknown as [{ files: File[] }])[0]
			.files;
		expect(files).toHaveLength(1);
		expect(files[0]?.name).toBe("asia-2027-story.png");
		expect(files[0]?.type).toBe("image/png");
	});

	it("copies the image where the clipboard takes PNGs", async () => {
		const write = vi.fn(async () => {});
		class FakeClipboardItem {
			static supports = (t: string) => t === "image/png";
			constructor(public items: Record<string, Blob>) {}
		}
		vi.stubGlobal("ClipboardItem", FakeClipboardItem);
		// After setup(): user-event installs its own clipboard stub.
		const user = userEvent.setup();
		const clip = vi
			.spyOn(navigator, "clipboard", "get")
			.mockReturnValue({ write } as unknown as Clipboard);
		render(<ShareButton slug="asia-2027" />);
		await user.click(screen.getByTestId(T.button));
		await screen.findByTestId(T.preview);
		await user.click(screen.getByTestId(T.copy));
		expect(write).toHaveBeenCalledTimes(1);
		const item = (
			write.mock.calls[0] as unknown as [FakeClipboardItem[]]
		)[0][0];
		expect(Object.keys(item?.items ?? {})).toEqual(["image/png"]);
		clip.mockRestore();
	});

	it("shows an error with a retry when the card can't be made", async () => {
		let fail: (r: Response) => void = () => {};
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					fail = resolve;
				}),
		);
		const user = userEvent.setup();
		render(<ShareButton slug="asia-2027" />);
		await user.click(screen.getByTestId(T.button));
		expect(screen.getByTestId(T.loading)).toHaveTextContent(
			"Drawing your route",
		);
		expect(screen.getByTestId(T.download)).toBeDisabled();
		fail(new Response("nope", { status: 503 }));
		expect(await screen.findByTestId(T.error)).toHaveTextContent(
			"Couldn't make the card",
		);
		expect(screen.getByTestId(T.download)).toBeDisabled();
		fireEvent.click(screen.getByTestId(T.retry));
		expect(await screen.findByTestId(T.preview)).toBeInTheDocument();
		expect(screen.getByTestId(T.download)).toBeEnabled();
	});
});
