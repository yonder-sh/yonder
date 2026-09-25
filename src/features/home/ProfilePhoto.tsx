/**
 * Profile › photo (owner FB-16): upload, change or remove your picture. A
 * picked file opens the circular crop (`AvatarCropper`); "Save photo" PUTs the
 * square bounding the circle to F's presigned upload and commits it
 * (`createAvatarUpload` → PUT → `commitAvatar`: resized server-side, stored
 * privately, served through `/api/avatar/…`); "Remove" goes back to the
 * initials in your presence colour (`removeAvatar`). Accounts only.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Camera, Trash2 } from "lucide-react";
import { type ChangeEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	commitAvatar,
	createAvatarUpload,
	removeAvatar,
} from "@/functions/avatar.functions";
import type { Viewer } from "@/lib/auth/viewer";
import { humanError } from "@/lib/errors";
import { meKeys, sessionKey } from "@/lib/query/keys";
import {
	AVATAR_CONTENT_TYPES,
	AVATAR_MAX_BYTES,
	type AvatarContentType,
} from "@/lib/schemas/avatar";
import { AvatarCropper, type CropSource, decodeImage } from "./AvatarCropper";
import { HOME_TESTID } from "./testids";

/** Pictures a browser can decode for the crop (the saved one is always WebP or JPEG). */
const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif";
/** Bigger files are rarely photos anyone means to use (and slow to decode on phones). */
const MAX_PICK_BYTES = 40 * 1024 * 1024;

/** Uploads the cropped square and makes it the account's picture. */
export async function uploadAvatar(blob: Blob): Promise<string | null> {
	const contentType = (AVATAR_CONTENT_TYPES as readonly string[]).includes(
		blob.type,
	)
		? (blob.type as AvatarContentType)
		: null;
	if (!contentType || blob.size > AVATAR_MAX_BYTES)
		throw new Error("Couldn't prepare the picture. Try another one.");
	const up = await createAvatarUpload({
		data: { contentType, size: blob.size },
	});
	const put = await fetch(up.url, {
		method: "PUT",
		headers: up.headers,
		body: blob,
	});
	if (!put.ok) throw new Error("The upload didn't go through. Try again.");
	const { image } = await commitAvatar({ data: { key: up.key } });
	return image;
}

export function ProfilePhoto({
	viewer,
	color,
	onCroppingChange,
}: {
	viewer: Pick<Viewer, "name" | "image">;
	/** Your presence colour on the open trip (0 on the dashboard). */
	color: number;
	/** The crop opened or closed (the Profile dialog hides its other fields). */
	onCroppingChange?: (cropping: boolean) => void;
}) {
	const qc = useQueryClient();
	const router = useRouter();
	const input = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const [picked, setPickedState] = useState<CropSource | null>(null);
	const setPicked = (img: CropSource | null) => {
		setPickedState(img);
		onCroppingChange?.(!!img);
	};
	const [error, setError] = useState<string | null>(null);
	const refresh = async () => {
		await Promise.all([
			qc.invalidateQueries({ queryKey: sessionKey }),
			qc.invalidateQueries({ queryKey: meKeys.trips }),
			qc.invalidateQueries({ queryKey: ["trip"] }),
		]);
		await router.invalidate();
	};
	const save = useMutation({
		meta: { silent: true },
		mutationFn: uploadAvatar,
		onSuccess: async () => {
			setPicked(null);
			setError(null);
			await refresh();
			toast.success("Photo saved");
		},
		onError: (e) => setError(humanError(e)),
	});
	const remove = useMutation({
		meta: { silent: true },
		mutationFn: () => removeAvatar(),
		onSuccess: async () => {
			setError(null);
			await refresh();
			toast.success("Photo removed");
		},
		onError: (e) => setError(humanError(e)),
	});
	const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = ""; // the same file again re-opens the crop
		if (!file) return;
		setError(null);
		if (file.size > MAX_PICK_BYTES) {
			setError("That file is too big. Pick a photo under 40 MB.");
			return;
		}
		try {
			setPicked(await decodeImage(file));
		} catch {
			setError(
				"That file isn't a picture this browser can open. Try a JPEG or PNG.",
			);
		}
	};
	const busy = save.isPending || remove.isPending;

	return (
		<div className="grid gap-3">
			{picked ? (
				<AvatarCropper
					image={picked}
					saving={save.isPending}
					onCancel={() => setPicked(null)}
					onSave={(blob) => save.mutate(blob)}
				/>
			) : (
				<div className="flex items-center gap-4">
					<MemberAvatar
						user={{ name: viewer.name, color, image: viewer.image }}
						size={64}
					/>
					<div className="grid gap-1.5">
						<span className="text-sm font-medium">Photo</span>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								data-testid={HOME_TESTID.avatarEdit}
								onClick={() => input.current?.click()}
							>
								<Camera /> {viewer.image ? "Change photo" : "Upload a photo"}
							</Button>
							{viewer.image ? (
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={busy}
									data-testid={HOME_TESTID.avatarRemove}
									onClick={() => remove.mutate()}
									className="text-muted-foreground"
								>
									<Trash2 /> Remove
								</Button>
							) : null}
						</div>
					</div>
				</div>
			)}
			<input
				ref={input}
				id={inputId}
				type="file"
				accept={ACCEPT}
				className="sr-only"
				tabIndex={-1}
				aria-label="Choose a photo"
				data-testid={HOME_TESTID.avatarFile}
				onChange={onPick}
			/>
			{error ? (
				<p className="text-[13px] text-destructive" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
