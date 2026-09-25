/**
 * Sharing (SPEC §12.5 `ShareDialog()`, DESIGN §8.4; EXTENSIONS §1.4 "Can
 * suggest"; ADDENDUM §8–§10 placeholders), opened with
 * `useUi().setShareOpen(true)`.
 *
 * PEOPLE: the owner invites by email with a role (Can view / Can rate / Can
 * suggest / Can edit; PLACES §1c), changes roles and removes people; emails show to the owner only.
 * People without an account (placeholders) get their tools here: "This is
 * me" (members: their own name, or any for owners and editors; link guests
 * never, QA A-10; it asks first, FB-15), and for owners and editors "Link an
 * email" (auto-claims on sign-up) and "Same person as…" (merge into a
 * member). There are no per-person join links (FB-14): people come in by
 * email invite or through the trip link. "+ Add a person without an
 * account" for everyone who can tag people. On phones the role sits under
 * the name (QA MOB-01).
 * LINK (owner; FB-13, like Google Drive): the trip's address IS its link,
 * one URL for everyone — "Anyone with the link" on/off, what they can do
 * (Can view / Can rate / Can suggest / Can edit; changing it changes
 * everyone who joined with it; a signed-in joiner of a "Can rate" link
 * becomes a rater member), the address with "Copy link", when the link was
 * made, expiry + Extend, and "Reset link" (a new address tail: the old
 * address stops working and link guests are removed) with an inline
 * confirmation (QA SHARE-08). Everyone else sees the same address to copy.
 * GUESTS (owner): signed-in guests can be promoted (a placeholder with their
 * name merges in, and the menu says so); any guest removed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
	Check,
	CircleOff,
	Copy,
	Link2,
	Mail,
	MoreHorizontal,
	RotateCcw,
	UserPlus,
	Users,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { MemberAvatar } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { ratingsCount } from "@/features/places/lib/rate";
import { RATING_TESTID } from "@/features/places/tab/rating-testids";
import {
	useCanCountRatings,
	useSetRatingsCounted,
} from "@/features/places/tab/use-rating-people";
import { can, roleLabel, type ShareRole } from "@/lib/auth/roles";
import { humanError } from "@/lib/errors";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { sessionQuery } from "@/lib/query/trip-queries";
import { normalizePersonName } from "@/lib/schemas/people";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ClaimConfirmDialog } from "./ClaimConfirm";
import { matchingPlaceholder, nameMatchesPerson } from "./claim-match";
import { useDialogFocus } from "./dialog-focus";
import { formatLocalDay } from "./link-dates";
import {
	addPlaceholder,
	extendShareLink,
	getSharing,
	inviteMember,
	linkPlaceholder,
	promoteGuest,
	removeGuest,
	removeMember,
	resetShareLink,
	type SharingDto,
	setShareLink,
	updateMemberRole,
} from "./sharing.functions";
import { HOME_TESTID } from "./testids";

/** The role choices, weakest first (EXTENSIONS §1.4 "Can suggest", PLACES §1c "Can rate"). */
const ROLES = [
	"viewer",
	"rater",
	"suggester",
	"editor",
] as const satisfies readonly ShareRole[];

type Member = SharingDto["members"][number];

/**
 * Fits the longest label ("Can suggest") whatever the font (QA HOME-8,
 * VIS-14); every row gets the same width so the column lines up.
 */
const ROLE_W = "min-w-[8.5rem]";
/** A role that can't be changed here ("Owner"), in the role column. */
const MEMBER_ROLE_TEXT = cn(
	"shrink-0 text-[13px] text-muted-foreground",
	"sm:min-w-[8.5rem] sm:pr-3 sm:text-right min-[380px]:max-sm:px-2",
);

function Section({
	title,
	children,
	aside,
}: {
	title: string;
	children: ReactNode;
	aside?: ReactNode;
}) {
	return (
		<section className="grid gap-2">
			<div className="flex items-center justify-between">
				<h3 className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
					{title}
				</h3>
				{aside}
			</div>
			{children}
		</section>
	);
}

function copy(text: string, what = "Link copied") {
	void navigator.clipboard
		?.writeText(text)
		.then(() => toast.success(what))
		.catch(() => toast.message("Select the link to copy it"));
}

function RoleSelect({
	value,
	onChange,
	disabled,
	testId,
	label,
	className,
}: {
	value: ShareRole;
	onChange: (r: ShareRole) => void;
	disabled?: boolean;
	testId?: string;
	label: string;
	className?: string;
}) {
	return (
		<Select
			value={value}
			onValueChange={(v) => onChange(v as ShareRole)}
			disabled={disabled}
		>
			<SelectTrigger
				size="sm"
				aria-label={label}
				data-testid={testId}
				className={cn(ROLE_W, "shrink-0", className)}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent align="end">
				{ROLES.map((r) => (
					<SelectItem key={r} value={r}>
						{roleLabel(r)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** Runs a sharing mutation, refreshing the dialog and the graph; errors toast. */
function useShareAction(tripId: string) {
	const qc = useQueryClient();
	return useMutation({
		// Errors toast once through the global MutationCache handler.
		mutationFn: async (fn: () => Promise<unknown>) => fn(),
		onSettled: () =>
			Promise.all([
				qc.invalidateQueries({ queryKey: tripKeys.sharing(tripId) }),
				qc.invalidateQueries({ queryKey: tripKeys.graph(tripId) }),
				qc.invalidateQueries({ queryKey: meKeys.trips }),
			]),
	});
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function InviteRow({ tripId }: { tripId: string }) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<ShareRole>("editor");
	const [error, setError] = useState<string | null>(null);
	const { disabled, reason } = useEditGuard();
	const qc = useQueryClient();
	const invite = useMutation({
		mutationFn: () =>
			inviteMember({ data: { tripId, email: email.trim(), role } }),
		meta: { silent: true },
		onSuccess: async (r) => {
			toast.success(
				r.status === "active"
					? `Added ${email.trim()}`
					: `Invited ${email.trim()}. They'll get an email.`,
			);
			setEmail("");
			setError(null);
			await Promise.all([
				qc.invalidateQueries({ queryKey: tripKeys.sharing(tripId) }),
				qc.invalidateQueries({ queryKey: tripKeys.graph(tripId) }),
			]);
		},
		onError: (e) => setError(humanError(e)),
	});
	const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!valid) {
			setError("Enter an email address like name@example.com.");
			return;
		}
		invite.mutate();
	};
	return (
		<form onSubmit={submit} className="grid gap-1.5">
			<div className="flex flex-wrap gap-2 sm:flex-nowrap">
				<Input
					type="email"
					inputMode="email"
					autoComplete="off"
					placeholder="Email address"
					value={email}
					aria-label="Invite by email"
					aria-invalid={!!error}
					disabled={disabled}
					onChange={(e) => {
						setEmail(e.target.value);
						setError(null);
					}}
					data-testid={HOME_TESTID.inviteEmail}
					className="h-8 min-w-0 flex-1 basis-full sm:basis-auto"
				/>
				<RoleSelect
					value={role}
					onChange={setRole}
					disabled={disabled}
					testId={HOME_TESTID.inviteRole}
					label="Role for the invite"
					// Phones: the role fills the row beside Invite (no ragged edge).
					className="max-sm:flex-1"
				/>
				<Button
					type="submit"
					size="sm"
					disabled={disabled || !email.trim() || invite.isPending}
					title={reason ?? undefined}
					data-testid={HOME_TESTID.inviteSubmit}
				>
					<Mail /> Invite
				</Button>
			</div>
			{error ? (
				<p className="text-[13px] text-destructive" role="alert">
					{error}
				</p>
			) : null}
		</form>
	);
}

type Panel = "email" | "merge";

function PlaceholderPanel({
	member,
	panel,
	members,
	onClose,
	tripId,
}: {
	member: Member;
	panel: Panel;
	members: Member[];
	onClose: () => void;
	tripId: string;
}) {
	const act = useShareAction(tripId);
	const [email, setEmail] = useState("");
	const { disabled } = useEditGuard();
	if (panel === "email")
		return (
			<form
				className="grid gap-1.5 rounded-lg bg-muted/60 p-3"
				onSubmit={(e) => {
					e.preventDefault();
					act.mutate(
						() =>
							linkPlaceholder({
								data: { memberId: member.id, email: email.trim() },
							}),
						{
							onSuccess: () => {
								toast.success(
									`${member.name} is linked to ${email.trim()}. They join as ${member.name} when they sign in.`,
								);
								onClose();
							},
						},
					);
				}}
			>
				<p className="text-xs text-muted-foreground">
					When {member.name} signs in with this email, everything tagged “
					{member.name}” becomes theirs.
				</p>
				<div className="flex gap-2">
					<Input
						type="email"
						autoFocus
						placeholder={`${member.name.toLowerCase().replace(/\s+/g, ".")}@example.com`}
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						aria-label={`Email for ${member.name}`}
						className="h-8 flex-1 bg-background"
					/>
					<Button
						type="submit"
						size="sm"
						disabled={disabled || !email.includes("@") || act.isPending}
					>
						Link
					</Button>
					<Button type="button" size="sm" variant="ghost" onClick={onClose}>
						Cancel
					</Button>
				</div>
			</form>
		);
	const targets = members.filter(
		(m) => m.id !== member.id && m.status !== "placeholder",
	);
	return (
		<div className="grid gap-1.5 rounded-lg bg-muted/60 p-3">
			<p className="text-xs text-muted-foreground">
				Their tags, ratings, splits and mentions move to the person you pick.
			</p>
			<div className="flex flex-wrap gap-1.5">
				{targets.map((t) => (
					<Button
						key={t.id}
						size="sm"
						variant="outline"
						disabled={disabled || act.isPending}
						onClick={() =>
							act.mutate(
								() =>
									linkPlaceholder({
										data: { memberId: member.id, toMemberId: t.id },
									}),
								{
									onSuccess: () => {
										toast.success(`${member.name} is now ${t.name}`);
										onClose();
									},
								},
							)
						}
					>
						<MemberAvatar
							user={{ name: t.name, color: t.color, memberId: t.id }}
							size={16}
						/>
						{t.name}
					</Button>
				))}
				<Button size="sm" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function MemberRow({
	m,
	me,
	owner,
	linker,
	canClaim,
	members,
	tripId,
}: {
	m: Member;
	me: string | null;
	owner: boolean;
	linker: boolean;
	canClaim: boolean;
	members: Member[];
	tripId: string;
}) {
	const [panel, setPanel] = useState<Panel | null>(null);
	const [claiming, setClaiming] = useState(false);
	const act = useShareAction(tripId);
	const { disabled, reason } = useEditGuard();
	const isMe = m.id === me;
	const placeholder = m.status === "placeholder";
	const pending = m.status === "invited";
	// Owners and editors leave someone's ratings out (or count them again).
	const { graph } = useWorkspace();
	const canCount = useCanCountRatings();
	const setCounted = useSetRatingsCounted();
	const gm = graph.members.find((x) => x.id === m.id);
	const counted = gm ? ratingsCount(gm) : true;
	const countable = canCount && !!gm && (m.role !== "viewer" || !counted);
	const first = gm?.firstName ?? m.name.split(/\s+/)[0] ?? m.name;
	const whose = isMe ? "your" : `${first}'s`;
	const roleControl =
		m.role === "owner" ? (
			<span className={MEMBER_ROLE_TEXT}>Owner</span>
		) : owner ? (
			<RoleSelect
				value={m.role as ShareRole}
				disabled={disabled}
				testId={HOME_TESTID.memberRole}
				label={`Role of ${m.name}`}
				// Phones on one line (380–639 px): as wide as its label and
				// borderless (a quiet "Can edit ▾" at the row's end), so the name
				// keeps the room. Narrower, it sits under the name as before.
				className="min-[380px]:max-sm:w-auto min-[380px]:max-sm:min-w-0 min-[380px]:max-sm:border-transparent min-[380px]:max-sm:bg-transparent min-[380px]:max-sm:px-2 min-[380px]:max-sm:shadow-none"
				onChange={(role) =>
					act.mutate(() => updateMemberRole({ data: { memberId: m.id, role } }))
				}
			/>
		) : (
			<span className={MEMBER_ROLE_TEXT}>{roleLabel(m.role)}</span>
		);
	const menu =
		(owner && m.role !== "owner") ||
		(placeholder && (linker || canClaim)) ||
		countable ? (
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={`More for ${m.name}`}
					data-testid={HOME_TESTID.memberMenu}
					disabled={disabled}
					className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
				>
					<MoreHorizontal className="size-4" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-56">
					{placeholder ? (
						<>
							<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
								{m.name} has no account yet
							</DropdownMenuLabel>
							{canClaim ? (
								<DropdownMenuItem
									data-testid={HOME_TESTID.placeholderClaim}
									// FB-15: never at once; the dialog explains what merges.
									onSelect={() => setClaiming(true)}
								>
									<Check /> This is me…
								</DropdownMenuItem>
							) : null}
							{linker ? (
								<>
									<DropdownMenuItem
										data-testid={HOME_TESTID.placeholderLinkEmail}
										onSelect={() => setPanel("email")}
									>
										<Mail /> Link an email…
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => setPanel("merge")}>
										<Users /> Same person as…
									</DropdownMenuItem>
								</>
							) : null}
						</>
					) : null}
					{countable ? (
						<>
							{placeholder && (linker || canClaim) ? (
								<DropdownMenuSeparator />
							) : null}
							<DropdownMenuItem
								data-testid={
									counted ? RATING_TESTID.leaveOut : RATING_TESTID.countAgain
								}
								onSelect={() =>
									setCounted.mutate({ memberId: m.id, counted: !counted })
								}
							>
								{counted ? <CircleOff /> : <RotateCcw />}
								{counted
									? `Leave out ${whose} ratings`
									: `Count ${whose} ratings again`}
							</DropdownMenuItem>
						</>
					) : null}
					{owner && m.role !== "owner" ? (
						<>
							{placeholder || countable ? <DropdownMenuSeparator /> : null}
							<DropdownMenuItem
								variant="destructive"
								onSelect={() =>
									act.mutate(() => removeMember({ data: { memberId: m.id } }), {
										onSuccess: () =>
											toast.success(
												pending
													? "Invite cancelled"
													: `${m.name} was removed from the trip`,
											),
									})
								}
							>
								{pending ? "Cancel invite" : "Remove from trip"}
							</DropdownMenuItem>
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		) : (
			<span className="size-8 shrink-0" />
		);
	return (
		<li
			className="grid gap-2"
			data-testid={HOME_TESTID.memberRow}
			data-status={m.status}
			data-member={m.id}
		>
			<div className="flex min-h-11 items-center gap-2 min-[380px]:gap-3">
				<MemberAvatar
					user={{ name: m.name, color: m.color, memberId: m.id }}
					size={28}
					className={cn(
						"self-start min-[380px]:self-center",
						(placeholder || pending) &&
							"opacity-80 outline-2 outline-dashed outline-offset-1 ring-0",
					)}
				/>
				{/*
				 * One line from 380 px (a 390 px phone included: before, "Owner" and
				 * each role Select dropped onto their own lines there and the list
				 * read loose); only narrower phones put the role under the name, so
				 * names stay readable at 320 px.
				 */}
				<span className="flex min-w-0 flex-1 flex-col items-start gap-1.5 min-[380px]:flex-row min-[380px]:items-center min-[380px]:gap-3">
					<span className="grid w-full min-w-0 sm:flex-1">
						<span className="flex min-w-0 items-baseline gap-1.5 text-sm">
							<span className="truncate font-medium">{m.name}</span>
							{isMe ? (
								<span className="shrink-0 text-muted-foreground">(you)</span>
							) : null}
						</span>
						{placeholder || pending || m.email || !counted ? (
							<span className="truncate text-[12px] text-muted-foreground">
								{pending ? (
									<span className="text-foreground/80">Pending</span>
								) : null}
								{pending && m.email ? " · " : null}
								{placeholder ? "No account yet" : m.email}
								{!counted ? (
									<span data-testid={RATING_TESTID.shareNotCounted}>
										{placeholder || m.email ? " · " : ""}
										{isMe ? "Your" : `${first}'s`} ratings aren't counted
									</span>
								) : null}
							</span>
						) : null}
					</span>
					{roleControl}
				</span>
				{disabled && reason && menu.type !== "span" ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<span>{menu}</span>
						</TooltipTrigger>
						<TooltipContent>{reason}</TooltipContent>
					</Tooltip>
				) : (
					menu
				)}
			</div>
			{panel && placeholder ? (
				<PlaceholderPanel
					member={m}
					panel={panel}
					members={members}
					tripId={tripId}
					onClose={() => setPanel(null)}
				/>
			) : null}
			{canClaim ? (
				<ClaimConfirmDialog
					tripId={tripId}
					placeholder={{ id: m.id, name: m.name }}
					open={claiming}
					onOpenChange={setClaiming}
				/>
			) : null}
		</li>
	);
}

function AddPersonRow({ tripId }: { tripId: string }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const { disabled, reason } = useEditGuard();
	const act = useShareAction(tripId);
	if (!open)
		return (
			<Button
				variant="ghost"
				size="sm"
				disabled={disabled}
				title={reason ?? undefined}
				data-testid={HOME_TESTID.addPerson}
				onClick={() => setOpen(true)}
				// Wraps on the narrowest phones instead of widening the dialog.
				className="h-auto min-h-8 max-w-full justify-self-start whitespace-normal text-left text-muted-foreground"
			>
				<UserPlus /> Add a person without an account
			</Button>
		);
	const clean = normalizePersonName(name);
	return (
		<form
			className="flex gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (!clean) return;
				act.mutate(
					() => addPlaceholder({ data: { tripId, displayName: clean } }),
					{
						onSuccess: () => {
							toast.success(`Added ${clean}. You can tag them anywhere now.`);
							setName("");
							setOpen(false);
						},
					},
				);
			}}
		>
			<Input
				autoFocus
				placeholder="Their name, e.g. Audrey"
				value={name}
				maxLength={60}
				onChange={(e) => setName(e.target.value)}
				aria-label="Name of the person"
				data-testid={HOME_TESTID.addPersonName}
				className="h-8 flex-1"
			/>
			<Button type="submit" size="sm" disabled={!clean || act.isPending}>
				Add
			</Button>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				onClick={() => setOpen(false)}
			>
				Cancel
			</Button>
		</form>
	);
}

// ---------------------------------------------------------------------------
// The link (owner; FB-13)
// ---------------------------------------------------------------------------

/** What "anyone with the link" can do, per role. */
const LINK_BLURB: Record<ShareRole, string> = {
	viewer: "They can see the plan.",
	rater: "They can see the plan and rate places once they sign in.",
	suggester: "They can suggest changes for you to review.",
	editor: "They can change the plan.",
};

/** The trip's address with "Copy link": the one link for everyone. */
function AddressRow({ url }: { url: string }) {
	return (
		<div className="flex gap-2">
			<Input
				readOnly
				value={url}
				onFocus={(e) => e.currentTarget.select()}
				className="h-8 min-w-0 font-mono text-xs"
				aria-label="Trip address"
				data-testid={TESTID.shareLinkUrl}
			/>
			<Button
				variant="outline"
				size="sm"
				onClick={() => copy(url)}
				data-testid={TESTID.shareLinkCopy}
			>
				<Copy /> Copy link
			</Button>
		</div>
	);
}

function TripLink({ tripId, data }: { tripId: string; data: SharingDto }) {
	const act = useShareAction(tripId);
	const [confirm, setConfirm] = useState(false);
	const { disabled } = useEditGuard();
	const link = data.link;
	const on = !!link?.enabled;
	const role: ShareRole = link?.role ?? "viewer";
	return (
		<Section title="Link">
			<div
				className="grid gap-2.5"
				data-testid={TESTID.shareLinkRow}
				data-role={role}
				data-enabled={on}
			>
				<div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
					<span
						className={cn(
							"flex size-8 shrink-0 items-center justify-center rounded-full",
							on
								? "bg-primary/10 text-primary"
								: "bg-muted text-muted-foreground",
						)}
						aria-hidden="true"
					>
						<Link2 className="size-4" />
					</span>
					<span className="grid min-w-0 flex-1">
						<span className="text-sm font-medium">Anyone with the link</span>
						<span className="text-[12px] text-muted-foreground">
							{on
								? LINK_BLURB[role]
								: "Off. Only the people above can open the trip."}
						</span>
					</span>
					<Switch
						className="sm:order-last"
						checked={on}
						disabled={disabled || act.isPending}
						aria-label="Anyone with the link"
						data-testid={TESTID.shareLinkSwitch}
						onCheckedChange={(enabled) =>
							act.mutate(() => setShareLink({ data: { tripId, enabled } }))
						}
					/>
					{on ? (
						// Phones: its own full-width line, flush with the address row
						// under it (one clean column); wider: before the switch.
						<span className="flex basis-full sm:basis-auto">
							<RoleSelect
								className="max-sm:flex-1"
								value={role}
								disabled={disabled || act.isPending}
								testId={HOME_TESTID.linkRole}
								label="What anyone with the link can do"
								onChange={(r) =>
									act.mutate(
										() => setShareLink({ data: { tripId, role: r } }),
										{
											onSuccess: () =>
												toast.success(
													`Everyone with the link ${roleLabel(r).toLowerCase()} now`,
												),
										},
									)
								}
							/>
						</span>
					) : null}
				</div>
				<AddressRow url={data.url} />
				{!confirm ? (
					<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
						<p
							className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
							data-testid={TESTID.shareLinkExpiry}
						>
							{on && link?.createdAt ? (
								<span data-testid={HOME_TESTID.linkCreated}>
									Created {formatLocalDay(link.createdAt)}
								</span>
							) : null}
							{on && link?.expiresAt ? (
								<span>
									{link.createdAt ? "· " : null}
									Works until {formatLocalDay(link.expiresAt)}
								</span>
							) : null}
							{on && link?.useCount ? (
								<span className="font-mono tnum">
									· opened {link.useCount}×
								</span>
							) : null}
							{on && link?.expiresAt ? (
								<Button
									variant="link"
									size="sm"
									className="h-auto p-0 text-xs"
									disabled={disabled}
									data-testid={TESTID.shareLinkExtend}
									onClick={() =>
										act.mutate(() => extendShareLink({ data: { tripId } }))
									}
								>
									Extend
								</Button>
							) : null}
						</p>
						<Button
							variant="ghost"
							size="sm"
							className="-mr-2 text-muted-foreground"
							disabled={disabled}
							data-testid={TESTID.shareLinkReset}
							onClick={() => setConfirm(true)}
						>
							<RotateCcw /> Reset link
						</Button>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[13px]">
						<span className="flex-1">
							{on
								? "The trip gets a new address: the old one stops working, and everyone who joined with the link is removed. Reset?"
								: "The trip gets a new address: the old one stops working. Reset?"}
						</span>
						<Button
							size="sm"
							variant="destructive"
							data-testid={HOME_TESTID.resetConfirm}
							onClick={() =>
								act.mutate(() => resetShareLink({ data: { tripId } }), {
									onSuccess: () => toast.success("The trip has a new address"),
									onSettled: () => setConfirm(false),
								})
							}
						>
							Reset
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
							Cancel
						</Button>
					</div>
				)}
			</div>
			<p className="text-xs text-muted-foreground">
				{on
					? "People on the trip open it at this address too. Changing what anyone with the link can do changes it for everyone who joined with it; turning it off removes them."
					: "People on the trip open it at this address. Turn the link on to share the trip with anyone, no account needed."}
			</p>
		</Section>
	);
}

// ---------------------------------------------------------------------------
// Guests (owner)
// ---------------------------------------------------------------------------

function ago(iso: string): string {
	const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
	if (min < 1) return "active now";
	if (min < 60) return `active ${min}m ago`;
	const h = Math.round(min / 60);
	if (h < 48) return `active ${h}h ago`;
	return `active ${Math.round(h / 24)}d ago`;
}

function Guests({ tripId, data }: { tripId: string; data: SharingDto }) {
	const act = useShareAction(tripId);
	const { disabled } = useEditGuard();
	if (!data.guests.length) return null;
	// `promoteGuestCore` merges the placeholder that looks like them: say so first.
	const twinOf = (name: string) => matchingPlaceholder(data.members, { name });
	return (
		<Section title="Guests">
			<ul className="grid gap-1">
				{data.guests.map((g) => (
					<li
						key={g.userId}
						data-testid={HOME_TESTID.guestRow}
						className="flex min-h-11 items-center gap-3"
					>
						<MemberAvatar
							user={{
								name: g.name,
								color: g.color,
								guest: true,
								userId: g.userId,
							}}
							size={28}
						/>
						<span className="grid min-w-0 flex-1">
							<span className="truncate text-sm font-medium">
								{g.name}
								{g.signedIn ? (
									<span className="font-normal text-muted-foreground">
										{" "}
										(signed in)
									</span>
								) : null}
							</span>
							<span className="text-[12px] text-muted-foreground">
								{roleLabel(g.role)} · joined with the link · {ago(g.lastSeenAt)}
							</span>
						</span>
						{g.signedIn ? (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										size="sm"
										variant="outline"
										disabled={disabled}
										data-testid={HOME_TESTID.guestPromote}
									>
										Add to trip
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="max-w-64">
									{twinOf(g.name) ? (
										<DropdownMenuLabel
											className="text-xs font-normal text-muted-foreground"
											data-testid={HOME_TESTID.guestPromoteTwin}
										>
											They become {twinOf(g.name)?.name}: what's tagged{" "}
											{twinOf(g.name)?.name} is theirs.
										</DropdownMenuLabel>
									) : null}
									<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
										As a member who…
									</DropdownMenuLabel>
									{ROLES.map((role) => (
										<DropdownMenuItem
											key={role}
											onSelect={() =>
												act.mutate(
													() =>
														promoteGuest({
															data: { tripId, userId: g.userId, role },
														}),
													{
														onSuccess: () =>
															toast.success(`${g.name} is on the trip now`),
													},
												)
											}
										>
											{roleLabel(role)}
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
						<Button
							size="sm"
							variant="ghost"
							disabled={disabled}
							// The address is the link: while it's on they can open it again.
							title="Removes them now. While the link is on, they can open it again; Reset link keeps them out."
							data-testid={HOME_TESTID.guestRemove}
							onClick={() =>
								act.mutate(() =>
									removeGuest({ data: { tripId, userId: g.userId } }),
								)
							}
						>
							Remove
						</Button>
					</li>
				))}
			</ul>
		</Section>
	);
}

// ---------------------------------------------------------------------------

export function ShareDialog() {
	const open = useUi((s) => s.shareOpen);
	const setOpen = useUi((s) => s.setShareOpen);
	const focus = useDialogFocus();
	const { graph, mode } = useWorkspace();
	const tripId = graph.trip.id;
	const sharing = useQuery({
		queryKey: tripKeys.sharing(tripId),
		queryFn: (): Promise<SharingDto> => getSharing({ data: { tripId } }),
		enabled: open && mode === "live",
	});
	const who = { role: graph.me.role, isGuest: graph.me.isGuest };
	const owner = can(who, "manageMembers");
	const linker = can(who, "linkPeople");
	const adder = can(who, "addPeople");
	// Members with an account say "This is me" for a placeholder with their
	// name (owners and editors for any); link guests never (QA A-10: the owner
	// adds them). Mirrors `claimPlaceholder`'s check.
	const session = useQuery({
		...sessionQuery(),
		enabled: open && mode === "live",
	});
	const account =
		mode === "live" &&
		!graph.me.isGuest &&
		!!session.data &&
		!session.data.isAnonymous;
	const canClaim = (m: Member) =>
		account &&
		m.status === "placeholder" &&
		(linker ||
			(!!session.data &&
				nameMatchesPerson(m.name, {
					name: session.data.name,
					firstName: session.data.firstName,
				})));
	const fallbackUrl =
		typeof window === "undefined"
			? ""
			: `${window.location.origin}/t/${graph.trip.slug}`;
	const data = sharing.data;
	const members = data?.members ?? [];
	const ordered = [
		...members.filter((m) => m.status === "active"),
		...members.filter((m) => m.status === "invited"),
		...members.filter((m) => m.status === "placeholder"),
	];
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				// Phones: a little less padding, so a row holds a name and its role.
				className="max-h-[calc(100svh-2rem)] gap-6 overflow-y-auto max-sm:gap-5 max-sm:p-5 sm:max-w-[560px]"
				data-testid={TESTID.shareDialog}
				// The dialog itself takes focus (no phone keyboard), Tab stays
				// inside, and closing goes back to the opener (QA A11Y-02).
				{...focus}
			>
				{/* Room for the close button beside a long name that wraps. */}
				<DialogHeader className="px-5 sm:px-0">
					<DialogTitle className="break-words">
						Share “{graph.trip.name}”
					</DialogTitle>
					<DialogDescription>
						{owner
							? "Invite people by email, or turn on a link anyone can open."
							: "The people planning this trip."}
					</DialogDescription>
				</DialogHeader>
				<Section title="People">
					{owner ? <InviteRow tripId={tripId} /> : null}
					<ul className="grid gap-1" aria-busy={sharing.isPending}>
						{sharing.isPending
							? [0, 1].map((i) => (
									<li
										key={i}
										className="flex h-11 items-center gap-3 opacity-60"
									>
										<span className="size-7 rounded-full bg-muted" />
										<span className="h-3 w-40 rounded bg-muted" />
									</li>
								))
							: ordered.map((m) => (
									<MemberRow
										key={m.id}
										m={m}
										me={graph.me.memberId}
										owner={owner}
										linker={linker}
										canClaim={canClaim(m)}
										members={members}
										tripId={tripId}
									/>
								))}
					</ul>
					{adder && mode === "live" ? <AddPersonRow tripId={tripId} /> : null}
				</Section>
				{owner && data ? <TripLink tripId={tripId} data={data} /> : null}
				{owner && data ? <Guests tripId={tripId} data={data} /> : null}
				{owner && data ? null : (
					// Everyone else: the same address (they can't see whether the
					// link is on, QA LINK-03), for other people on the trip.
					<div className="grid gap-1.5 border-t pt-4">
						<span className="text-xs text-muted-foreground">
							People on the trip open it at this address.
						</span>
						<AddressRow url={data?.url ?? fallbackUrl} />
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
