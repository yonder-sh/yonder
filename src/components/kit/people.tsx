/**
 * People, live (One Yonder kit, "Live together, quietly"):
 * - `LiveAvatar`: someone in the trip, with a green dot while they're here
 *   (the avatar's ring is already their presence colour).
 * - `HereBadge`: "Maya" in her colour, on the stop, place or day she has
 *   open, or "Maya · just now" on what she just changed.
 * `AvatarStack` and `MemberAvatar` are the shared people pieces, re-exported.
 */

import type { CSSProperties } from "react";
import {
	type AvatarPerson,
	type AvatarPx,
	MemberAvatar,
	presenceColor,
	resolveMember,
} from "@/components/common/member";
import { cn } from "@/lib/utils";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";

export {
	AvatarStack,
	MemberAvatar,
	MemberName,
} from "@/components/common/member";

export function LiveAvatar({
	memberId,
	user,
	online = true,
	size = 28,
	className,
}: {
	memberId?: string;
	user?: AvatarPerson;
	/** Here now (a green dot); false greys them a little. */
	online?: boolean;
	size?: AvatarPx;
	className?: string;
}) {
	const dot = size <= 20 ? "size-2" : "size-2.5";
	return (
		<span
			data-online={online || undefined}
			className={cn(
				"relative inline-flex shrink-0",
				!online && "opacity-60",
				className,
			)}
		>
			<MemberAvatar memberId={memberId} user={user} size={size} />
			{online ? (
				<span
					aria-hidden
					className={cn(
						"absolute -right-0.5 -bottom-0.5 rounded-full bg-online ring-2 ring-background",
						dot,
					)}
				/>
			) : null}
		</span>
	);
}

export function HereBadge({
	memberId,
	user,
	label,
	className,
}: {
	memberId?: string;
	user?: AvatarPerson;
	/** Instead of their first name ("Maya · just now", "Audrey is typing"). */
	label?: string;
	className?: string;
}) {
	const ws = useWorkspaceOptional();
	const member = memberId
		? resolveMember(ws?.graph.members ?? [], memberId)
		: undefined;
	const name = user?.name ?? member?.name ?? "Someone";
	const color = presenceColor(user?.color ?? member?.color);
	return (
		<span
			data-slot="here-badge"
			style={{ "--here": color } as CSSProperties}
			className={cn(
				"inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-full bg-(--here) py-0.5 pr-2 pl-0.5 text-2xs font-semibold whitespace-nowrap text-white",
				className,
			)}
		>
			<MemberAvatar memberId={memberId} user={user} size={16} ring={false} />
			<span className="truncate">{label ?? name.split(" ")[0]}</span>
		</span>
	);
}
