/**
 * "Install app" (SPEC §12.5 `InstallButton()`, DESIGN §10.5): an item of the
 * account menu (render it inside a DropdownMenu). Chromium: the captured
 * install prompt. iOS Safari: how to add it to the Home Screen. Installed
 * already, or not installable: nothing.
 */
import { Download } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TESTID } from "@/lib/testids";
import { promptInstall, useInstallMode } from "./install";

export function InstallButton() {
	const mode = useInstallMode();
	if (!mode) return null;
	return (
		<DropdownMenuItem
			data-testid={TESTID.installButton}
			onSelect={() => {
				if (mode === "prompt") void promptInstall();
				else
					toast("Install Yonder", {
						description:
							"Tap the Share button, then “Add to Home Screen”. Yonder opens like an app and keeps your last trip for offline reading.",
						duration: 10_000,
					});
			}}
		>
			<Download /> Install app
		</DropdownMenuItem>
	);
}
