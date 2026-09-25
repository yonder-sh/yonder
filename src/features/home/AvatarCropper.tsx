/**
 * The profile picture's CIRCULAR crop (owner FB-16): the photo on a canvas
 * under a round mask; drag (or arrow keys) to move it, zoom with the slider,
 * the wheel, a pinch or +/-. The photo always covers the circle. "Save photo"
 * hands back the square bounding the circle (`OUTPUT_PX`, WebP, else JPEG);
 * every avatar is then drawn round (`PersonAvatar`). No dependencies: canvas
 * and pointer events only.
 *
 * Owner, after the first build: "it should be circular crop though". The
 * circle has to be what reads as the crop, not the square stage around it:
 * the stage is dark, everything outside the circle is dimmed hard (the photo
 * is only a faint guide there), the circle has a bold white ring, and a
 * small round preview shows the avatar exactly as it will appear.
 */
import { ZoomIn, ZoomOut } from "lucide-react";
import { Slider } from "radix-ui";
import {
	type KeyboardEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	type Crop,
	clampCrop,
	drawRect,
	type ImageSize,
	MAX_ZOOM,
	MIN_ZOOM,
	OUTPUT_PX,
	sourceSquare,
	zoomAround,
} from "./avatar-crop";
import { HOME_TESTID } from "./testids";

/** The stage (CSS px) and the circle in it. Fits a 320 px phone's dialog. */
export const STAGE_PX = 256;
export const CIRCLE_PX = 224;
/** The round "this is you" preview (CSS px), the size of the Profile avatar. */
const PREVIEW_PX = 40;
/** The stage behind the photo, and the dim over everything outside the circle. */
const STAGE_FILL = "#12141c";
const OUTSIDE_DIM = "rgba(12, 14, 22, 0.78)";

export type CropSource = CanvasImageSource & ImageSize;

/**
 * Stage px per CSS px on each axis. The stage is drawn square, but on a phone
 * narrower than the stage it is scaled down, so each axis is measured on its
 * own: one factor from the width alone was wrong vertically whenever the box
 * wasn't square (a 240 × 256 box on a 320 px phone).
 */
export function stageScale(box: Pick<DOMRect, "width" | "height">): {
	kx: number;
	ky: number;
} {
	const kx = box.width > 0 ? STAGE_PX / box.width : 1;
	const ky = box.height > 0 ? STAGE_PX / box.height : kx;
	return { kx, ky };
}

/** A client point as stage px from the circle's centre. */
export function fromCentre(
	canvas: Pick<HTMLCanvasElement, "getBoundingClientRect"> | null,
	clientX: number,
	clientY: number,
): { x: number; y: number } {
	const box = canvas?.getBoundingClientRect();
	if (!box?.width || !box.height) return { x: 0, y: 0 };
	const { kx, ky } = stageScale(box);
	return {
		x: (clientX - box.left) * kx - STAGE_PX / 2,
		y: (clientY - box.top) * ky - STAGE_PX / 2,
	};
}

/** Decodes a picked file, upright (EXIF orientation applied). */
export async function decodeImage(file: Blob): Promise<CropSource> {
	if (typeof createImageBitmap === "function") {
		try {
			const bmp = await createImageBitmap(file, {
				imageOrientation: "from-image",
			});
			return Object.assign(bmp, { w: bmp.width, h: bmp.height });
		} catch {
			// fall through to <img> (older Safari)
		}
	}
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.decoding = "async";
		img.src = url;
		await img.decode();
		return Object.assign(img, { w: img.naturalWidth, h: img.naturalHeight });
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** The square bounding the circle, as a WebP (JPEG where WebP can't be encoded). */
export async function renderCrop(
	img: CropSource,
	crop: Crop,
	px = OUTPUT_PX,
): Promise<Blob> {
	const canvas = document.createElement("canvas");
	canvas.width = px;
	canvas.height = px;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("This browser can't crop pictures.");
	ctx.imageSmoothingQuality = "high";
	// The corners outside the circle are never shown; keep them opaque.
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, px, px);
	const { sx, sy, size } = sourceSquare(img, CIRCLE_PX, crop);
	ctx.drawImage(img, sx, sy, size, size, 0, 0, px, px);
	const encode = (type: string) =>
		new Promise<Blob | null>((resolve) =>
			canvas.toBlob((b) => resolve(b), type, 0.9),
		);
	const webp = await encode("image/webp");
	if (webp?.type === "image/webp") return webp;
	const jpeg = await encode("image/jpeg");
	if (!jpeg) throw new Error("Couldn't prepare the picture.");
	return jpeg;
}

/** The avatar as it will be shown: the saved square, drawn round. */
function CropPreview({ image, crop }: { image: CropSource; crop: Crop }) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = ref.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const px = Math.round(
			PREVIEW_PX * Math.min(3, window.devicePixelRatio || 1),
		);
		canvas.width = px;
		canvas.height = px;
		ctx.imageSmoothingQuality = "high";
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, px, px);
		const { sx, sy, size } = sourceSquare(image, CIRCLE_PX, crop);
		ctx.drawImage(image, sx, sy, size, size, 0, 0, px, px);
	}, [image, crop]);
	return (
		<canvas
			ref={ref}
			width={PREVIEW_PX}
			height={PREVIEW_PX}
			aria-hidden
			data-avatar-preview=""
			className="size-10 shrink-0 rounded-full ring-2 ring-border ring-offset-1 ring-offset-background"
		/>
	);
}

export function AvatarCropper({
	image,
	saving,
	onCancel,
	onSave,
}: {
	image: CropSource;
	saving?: boolean;
	onCancel: () => void;
	onSave: (blob: Blob) => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [crop, setCropState] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
	const cropRef = useRef(crop);
	const setCrop = useCallback(
		(next: Crop | ((c: Crop) => Crop)) => {
			const c = clampCrop(
				image,
				CIRCLE_PX,
				typeof next === "function" ? next(cropRef.current) : next,
			);
			cropRef.current = c;
			setCropState(c);
		},
		[image],
	);
	const pointers = useRef(new Map<number, { x: number; y: number }>());

	// Paint: a dark stage, the photo, then everything outside the circle
	// dimmed hard, so the bright circle is what you see as the crop.
	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const dpr = Math.min(3, window.devicePixelRatio || 1);
		canvas.width = STAGE_PX * dpr;
		canvas.height = STAGE_PX * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = STAGE_FILL;
		ctx.fillRect(0, 0, STAGE_PX, STAGE_PX);
		ctx.imageSmoothingQuality = "high";
		const r = drawRect(image, STAGE_PX, CIRCLE_PX, crop);
		ctx.drawImage(image, r.left, r.top, r.width, r.height);
		const mid = STAGE_PX / 2;
		const radius = CIRCLE_PX / 2;
		ctx.beginPath();
		ctx.rect(0, 0, STAGE_PX, STAGE_PX);
		ctx.arc(mid, mid, radius, 0, Math.PI * 2);
		ctx.fillStyle = OUTSIDE_DIM;
		ctx.fill("evenodd");
		// A soft dark halo just outside the ring keeps it visible on pale photos.
		ctx.beginPath();
		ctx.arc(mid, mid, radius + 1.5, 0, Math.PI * 2);
		ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
		ctx.lineWidth = 2;
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(mid, mid, radius, 0, Math.PI * 2);
		ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
		ctx.lineWidth = 2;
		ctx.stroke();
	}, [image, crop]);

	// The wheel zooms around the pointer (non-passive, so the page doesn't scroll).
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const p = fromCentre(canvas, e.clientX, e.clientY);
			setCrop((c) =>
				zoomAround(
					image,
					CIRCLE_PX,
					c,
					c.zoom * Math.exp(-e.deltaY / 400),
					p.x,
					p.y,
				),
			);
		};
		canvas.addEventListener("wheel", onWheel, { passive: false });
		return () => canvas.removeEventListener("wheel", onWheel);
	}, [image, setCrop]);

	const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
	};
	const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
		const map = pointers.current;
		const prev = map.get(e.pointerId);
		if (!prev) return;
		const { kx, ky } = stageScale(e.currentTarget.getBoundingClientRect());
		if (map.size === 1) {
			map.set(e.pointerId, { x: e.clientX, y: e.clientY });
			setCrop((c) => ({
				...c,
				x: c.x + (e.clientX - prev.x) * kx,
				y: c.y + (e.clientY - prev.y) * ky,
			}));
			return;
		}
		// Two fingers: pinch around their midpoint.
		const other = [...map.entries()].find(([id]) => id !== e.pointerId)?.[1];
		map.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (!other) return;
		// The pinch spread in stage px, so a scaled-down stage zooms like a full one.
		const before = Math.hypot((prev.x - other.x) * kx, (prev.y - other.y) * ky);
		const after = Math.hypot(
			(e.clientX - other.x) * kx,
			(e.clientY - other.y) * ky,
		);
		if (before < 1) return;
		const mid = fromCentre(
			e.currentTarget,
			(e.clientX + other.x) / 2,
			(e.clientY + other.y) / 2,
		);
		setCrop((c) =>
			zoomAround(image, CIRCLE_PX, c, (c.zoom * after) / before, mid.x, mid.y),
		);
	};
	const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
		pointers.current.delete(e.pointerId);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
		const step = e.shiftKey ? 32 : 8;
		const move: Record<string, [number, number]> = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, -step],
			ArrowDown: [0, step],
		};
		const d = move[e.key];
		if (d) {
			e.preventDefault();
			setCrop((c) => ({ ...c, x: c.x + d[0], y: c.y + d[1] }));
		} else if (e.key === "+" || e.key === "=") {
			e.preventDefault();
			setCrop((c) => zoomAround(image, CIRCLE_PX, c, c.zoom + 0.1));
		} else if (e.key === "-" || e.key === "_") {
			e.preventDefault();
			setCrop((c) => zoomAround(image, CIRCLE_PX, c, c.zoom - 0.1));
		}
	};

	return (
		<div
			className="grid justify-items-center gap-3"
			data-testid={HOME_TESTID.avatarCropper}
		>
			<canvas
				ref={canvasRef}
				width={STAGE_PX}
				height={STAGE_PX}
				tabIndex={0}
				role="img"
				aria-label="Photo crop. Drag or use the arrow keys to move the photo, + and − to zoom."
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				onKeyDown={onKeyDown}
				// Width-driven and square: on a phone narrower than the stage it
				// shrinks on both axes (a fixed height with max-w-full squashed
				// only the width: an oval "circle" and a distorted photo).
				className="aspect-square h-auto w-64 max-w-full cursor-grab touch-none rounded-xl bg-[#12141c] outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
			/>
			<div className="flex w-full max-w-64 items-center gap-2">
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="size-8 shrink-0 text-muted-foreground"
					aria-label="Zoom out"
					disabled={crop.zoom <= MIN_ZOOM}
					onClick={() =>
						setCrop((c) => zoomAround(image, CIRCLE_PX, c, c.zoom - 0.25))
					}
				>
					<ZoomOut />
				</Button>
				{/* The shadcn Slider's look, with the name on the thumb (what gets focus). */}
				<Slider.Root
					min={MIN_ZOOM}
					max={MAX_ZOOM}
					step={0.01}
					value={[crop.zoom]}
					data-testid={HOME_TESTID.avatarZoom}
					onValueChange={([z]) =>
						setCrop((c) => zoomAround(image, CIRCLE_PX, c, z ?? c.zoom))
					}
					className="relative flex w-full touch-none items-center select-none"
				>
					<Slider.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
						<Slider.Range className="absolute h-full bg-primary" />
					</Slider.Track>
					<Slider.Thumb
						aria-label="Zoom"
						className="block size-4 shrink-0 cursor-grab rounded-full border border-primary bg-white shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden"
					/>
				</Slider.Root>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="size-8 shrink-0 text-muted-foreground"
					aria-label="Zoom in"
					disabled={crop.zoom >= MAX_ZOOM}
					onClick={() =>
						setCrop((c) => zoomAround(image, CIRCLE_PX, c, c.zoom + 0.25))
					}
				>
					<ZoomIn />
				</Button>
			</div>
			<div className="flex items-center gap-3">
				<CropPreview image={image} crop={crop} />
				<p className="text-xs text-muted-foreground">
					Drag to place your face in the circle.
					<br />
					This is how you'll look to others.
				</p>
			</div>
			<div className="flex w-full justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={saving}
					onClick={onCancel}
				>
					Cancel
				</Button>
				<Button
					type="button"
					size="sm"
					disabled={saving}
					data-testid={HOME_TESTID.avatarSave}
					onClick={async () => onSave(await renderCrop(image, cropRef.current))}
				>
					{saving ? "Saving…" : "Save photo"}
				</Button>
			</div>
		</div>
	);
}
