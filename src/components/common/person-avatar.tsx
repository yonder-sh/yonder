/**
 * One person's avatar, everywhere a person appears (owner FB-16; DESIGN
 * §2.2, §4.1): their profile picture when they have one, else their
 * initials on the darkened presence colour. ALWAYS a circle: the picture is
 * stored as the square bounding the crop circle and is clipped round here,
 * whatever its source.
 *
 * Who it is: pass `memberId` inside a workspace, or `person` anywhere. A
 * `person` that carries `memberId`/`userId` is matched against the CURRENT
 * `graph.members` for the latest picture (a change reaches open tabs through
 * the live `graph` invalidation); otherwise its own `image` is used.
 * Placeholders, guests and people without a picture keep the initials.
 * `MemberAvatar` (`./member`) is this component.
 */
import { cn } from "cn";
import type { CSSProperties } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { GraphMember } from "@/lib/engine/types";
import { initials } from "@/lib/format";
import { avatarSrc } from "@/lib/schemas/avatar";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";

/**
 * The member an id stands for: follows `mergedIntoId` (a claimed or linked
 * placeholder) so old ids in notes and payloads show the person they became.
 */
export function resolveMember(
	members: readonly GraphMember[],
	memberId: string,
): GraphMember | undefined {
	let m = members.find((x) => x.id === memberId);
	for (let hops = 0; m?.mergedIntoId && hops < 4; hops++) {
		const next = members.find((x) => x.id === m?.mergedIntoId);
		if (!next) break;
		m = next;
	}
	return m;
}

/** `--presence-(n+1)` for a colour index 0..7. */
export function presenceColor(color: number | null | undefined): string {
	const n = Number.isInteger(color) ? ((color as number) % 8) + 1 : 1;
	return `var(--presence-${n})`;
}

/**
 * The avatar's fill behind white initials: the presence colour darkened in
 * OKLab so the initials pass WCAG AA (≥ 4.5:1) for all eight colours, in
 * light (≥ 5.8:1) and dark (≥ 4.9:1) themes (QA A11Y-01). Rings keep the
 * plain presence colour.
 */
export function presenceFill(color: number | null | undefined): string {
	return `color-mix(in oklab, ${presenceColor(color)} 75%, black)`;
}

export type AvatarPerson = {
	name: string;
	color: number;
	/** `user.image` (`/api/avatar/<userId>?v=…`), when known. */
	image?: string | null;
	/** Guests get a dotted ring (DESIGN §4.1). */
	guest?: boolean;
	/** Match against `graph.members` for the current picture. */
	memberId?: string | null;
	userId?: string | null;
};

export const AVATAR_PX = {
	16: "size-4 text-[8px]",
	20: "size-5 text-[9px]",
	28: "size-7 text-[11px]",
	40: "size-10 text-sm",
	64: "size-16 text-xl",
	96: "size-24 text-3xl",
} as const;
export type AvatarPx = keyof typeof AVATAR_PX;

export function PersonAvatar({
	memberId,
	person: given,
	size = 28,
	ring = true,
	className,
	title,
}: {
	memberId?: string;
	person?: AvatarPerson;
	size?: AvatarPx;
	ring?: boolean;
	className?: string;
	title?: string;
}) {
	const ws = useWorkspaceOptional();
	const members = ws?.graph.members ?? [];
	const lookupId = memberId ?? given?.memberId ?? undefined;
	const member = lookupId
		? resolveMember(members, lookupId)
		: given?.userId
			? members.find((m) => m.userId === given.userId && m.status !== "removed")
			: undefined;
	// A link guest (the owner's `graph.guests`) has no member row.
	const guestRow =
		!member && given?.userId
			? ws?.graph.guests?.find((g) => g.userId === given.userId)
			: undefined;
	const person: AvatarPerson | undefined = given
		? {
				...given,
				image: member ? member.image : (given.image ?? guestRow?.image),
			}
		: member
			? { name: member.name, color: member.color, image: member.image }
			: undefined;
	// QA TAG-04: a removed member greys out everywhere, as MemberName does.
	const former = !person || member?.status === "removed";
	const name = person?.name ?? "Former member";
	const label = person && former ? `${name} (former member)` : name;
	const image = person?.image && !former ? avatarSrc(person.image, size) : null;
	return (
		<Avatar
			title={title ?? label}
			data-former-member={former ? "" : undefined}
			data-avatar-image={image ? "" : undefined}
			className={cn(
				"aspect-square rounded-full",
				AVATAR_PX[size],
				ring &&
					(size <= 16
						? "ring-1 ring-offset-0"
						: "ring-2 ring-offset-1 ring-offset-background"),
				person?.guest && "outline-dotted outline-2 outline-offset-1 ring-0",
				former && "opacity-50 grayscale",
				className,
			)}
			style={
				ring
					? ({
							"--tw-ring-color": presenceColor(person?.color),
							outlineColor: presenceColor(person?.color),
						} as CSSProperties)
					: undefined
			}
		>
			{image ? (
				<AvatarImage
					src={image}
					alt=""
					draggable={false}
					className="rounded-full object-cover"
				/>
			) : null}
			<AvatarFallback
				className="rounded-full font-medium text-white"
				style={{ backgroundColor: presenceFill(person?.color) }}
			>
				{/* Two letters don't fit a 16px circle ("MC" runs into the ring). */}
				{size <= 16 ? initials(name).slice(0, 1) : initials(name)}
			</AvatarFallback>
		</Avatar>
	);
}
