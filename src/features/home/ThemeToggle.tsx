import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { type Theme, useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeToggle() {
	const { theme, setTheme } = useTheme();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="outline" size="icon" aria-label="Toggle theme">
					<SunIcon className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
					<MoonIcon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup
					value={theme}
					onValueChange={(v) => setTheme(v as Theme)}
				>
					<DropdownMenuRadioItem value="light">
						<SunIcon /> Light
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="dark">
						<MoonIcon /> Dark
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="system">
						<MonitorIcon /> System
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
