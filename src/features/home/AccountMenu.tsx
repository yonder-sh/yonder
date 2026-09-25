/**
 * The account menu (SPEC §12.5 `AccountMenu()`, DESIGN §10.5): the 28px
 * avatar at the far right — Profile, theme, Install app, Sign out. Link
 * guests get "Sign in to keep this trip" (and "Change your name") instead of
 * Profile.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { LogIn, LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";
import { MemberAvatar } from "@/components/common/member";
import { type Theme, useTheme } from "@/components/theme-provider";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InstallButton } from "@/features/offline/InstallButton";
import { signOut } from "@/lib/auth/sign-out";
import type { Viewer } from "@/lib/auth/viewer";
import { sessionQuery } from "@/lib/query/trip-queries";
import { TESTID } from "@/lib/testids";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { useUi } from "@/lib/workspace/ui-store";

export function AccountMenu({
	viewer,
}: {
	/**
	 * The route's viewer (the dashboard has it from its guard): the avatar is
	 * right on the first paint, before the session query runs (DASH-03 showed
	 * "Y" for "You").
	 */
	viewer?: Pick<Viewer, "name" | "image" | "email" | "isAnonymous">;
} = {}) {
	const ws = useWorkspaceOptional();
	const session = useQuery({
		...sessionQuery(),
		enabled: !ws || ws.mode === "live",
	});
	const qc = useQueryClient();
	const { theme, setTheme } = useTheme();
	const setProfileOpen = useUi((s) => s.setProfileOpen);
	const location = useLocation();
	const me = session.data ?? viewer;
	const name = me?.name ?? ws?.graph.me.name ?? "You";
	const color = ws?.graph.me.color ?? 0;
	const guest = me?.isAnonymous ?? false;
	const next = `${location.pathname}${location.searchStr ?? ""}`;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				data-testid={TESTID.accountMenu}
				aria-label={`Account: ${name}`}
				className="rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			>
				<MemberAvatar
					user={{
						name,
						color,
						image: me?.image,
						guest,
					}}
					size={28}
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-60">
				<DropdownMenuLabel className="grid">
					<span className="truncate">{name}</span>
					<span className="truncate text-xs font-normal text-muted-foreground">
						{guest ? "Guest on this device" : (me?.email ?? "")}
					</span>
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{guest ? (
					<DropdownMenuItem asChild>
						<a href={`/login?${new URLSearchParams({ next })}`}>
							<LogIn /> Sign in to keep this trip
						</a>
					</DropdownMenuItem>
				) : null}
				<DropdownMenuItem onSelect={() => setProfileOpen(true)}>
					<UserRound /> {guest ? "Change your name" : "Profile"}
				</DropdownMenuItem>
				<InstallButton />
				<DropdownMenuSeparator />
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
					Theme
				</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={theme}
					onValueChange={(v) => setTheme(v as Theme)}
				>
					<DropdownMenuRadioItem value="light">
						<Sun /> Light
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="dark">
						<Moon /> Dark
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="system">
						<Monitor /> System
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => void signOut({ queryClient: qc })}>
					<LogOut /> Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
