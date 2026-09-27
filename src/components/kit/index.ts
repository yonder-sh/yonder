/**
 * The One Yonder kit (2026-09-28): the one set of components every screen is
 * built from. Import from "@/components/kit"; the shadcn primitives in
 * `components/ui` are retuned to the same sizes (28 / 32 / 40 / 44). The
 * gallery is /dev/kit (dev builds), and the kit guard test keeps arbitrary
 * sizes and raw colours from coming back.
 */
export { EmptyState } from "@/components/common/empty-state";
export { DurationInput, TimeInput } from "@/components/common/time";
export { Chip, type ChipTone, chipVariants } from "./chip";
export {
	AvatarStack,
	HereBadge,
	LiveAvatar,
	MemberAvatar,
	MemberName,
} from "./people";
export {
	PersonRating,
	RATING_FILL,
	RatingButtons,
	RatingDot,
	RatingMenu,
	RatingPill,
	ratingVars,
} from "./rating";
export { Eyebrow, Section, SectionHeader } from "./section";
export { Segmented, type SegmentedOption } from "./segmented";
