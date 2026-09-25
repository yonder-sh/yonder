/**
 * Account → Notifications (Web Push): this device on/off, one switch per
 * type (every type starts on), and the trips muted from their trip menu.
 * Switches save at once; nothing here needs "Save".
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BellOff } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
	type PushSettingsDto,
	setPushType,
	setTripMuted,
} from "@/functions/push.functions";
import { humanError } from "@/lib/errors";
import { PUSH_TYPE_INFO, PUSH_TYPES, type PushType } from "@/lib/push/types";
import {
	deviceOff,
	disablePush,
	enablePush,
	permission,
	pushEnv,
} from "./push-client";
import { PUSH_TESTID } from "./testids";
import { pushSettingsKey, usePushSettings } from "./use-push";

function deviceNote(data: PushSettingsDto | undefined): {
	text: string;
	blocked: boolean;
} {
	if (data && !data.publicKey)
		return {
			text: "Notifications aren't set up on this server yet.",
			blocked: true,
		};
	const env = pushEnv();
	if (env === "ios-install")
		return {
			text: "On iPhone and iPad, add Yonder to your Home Screen (Share → Add to Home Screen) and open it from there to get notifications.",
			blocked: true,
		};
	if (env === "unsupported")
		return { text: "This browser can't show notifications.", blocked: true };
	if (permission() === "denied")
		return {
			text: "Notifications are blocked for Yonder in this browser's settings.",
			blocked: true,
		};
	return {
		text: "Get notifications from Yonder in this browser.",
		blocked: false,
	};
}

export function NotificationsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const settings = usePushSettings(open);
	const qc = useQueryClient();
	const data = settings.data;
	const note = deviceNote(data);
	const deviceId = useId();
	const [deviceBusy, setDeviceBusy] = useState(false);
	const deviceOn = !!data?.thisDevice && !deviceOff();

	const patch = (fn: (d: PushSettingsDto) => PushSettingsDto) =>
		qc.setQueryData<PushSettingsDto>(pushSettingsKey, (d) => (d ? fn(d) : d));

	const setType = useMutation({
		meta: { silent: true },
		mutationFn: (v: { type: PushType; on: boolean }) =>
			setPushType({ data: v }),
		onMutate: (v) =>
			patch((d) => ({
				...d,
				offTypes: v.on
					? d.offTypes.filter((t) => t !== v.type)
					: [...new Set([...d.offTypes, v.type])],
			})),
		onSuccess: (r) => patch((d) => ({ ...d, offTypes: r.offTypes })),
		onError: (e) => {
			toast.error(humanError(e));
			void qc.invalidateQueries({ queryKey: pushSettingsKey });
		},
	});

	const unmute = useMutation({
		meta: { silent: true },
		mutationFn: (tripId: string) =>
			setTripMuted({ data: { tripId, muted: false } }),
		onMutate: (tripId) =>
			patch((d) => ({
				...d,
				mutedTrips: d.mutedTrips.filter((t) => t.id !== tripId),
			})),
		onError: (e) => {
			toast.error(humanError(e));
			void qc.invalidateQueries({ queryKey: pushSettingsKey });
		},
	});

	const toggleDevice = async (on: boolean) => {
		if (!data?.publicKey) return;
		setDeviceBusy(true);
		try {
			if (on) {
				const r = await enablePush(data.publicKey);
				if (r === "denied")
					toast("Notifications are blocked", {
						description: "Allow them for Yonder in your browser's settings.",
					});
				else if (r === "unavailable")
					toast("Notifications aren't available in this browser");
			} else await disablePush();
		} catch (e) {
			toast.error(humanError(e));
		} finally {
			setDeviceBusy(false);
			await qc.invalidateQueries({ queryKey: pushSettingsKey });
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-[440px]"
				data-testid={PUSH_TESTID.dialog}
			>
				<DialogHeader>
					<DialogTitle className="text-xl">Notifications</DialogTitle>
					<DialogDescription>
						What Yonder tells you about, on the devices where you turn it on.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-5">
					<div className="flex items-start justify-between gap-4">
						<div className="grid gap-1">
							<Label htmlFor={deviceId}>This device</Label>
							<p
								className="text-xs text-muted-foreground"
								data-testid={PUSH_TESTID.deviceNote}
							>
								{note.text}
							</p>
						</div>
						<Switch
							id={deviceId}
							checked={deviceOn}
							disabled={note.blocked || deviceBusy || !data}
							onCheckedChange={(v) => void toggleDevice(v)}
							data-testid={PUSH_TESTID.device}
						/>
					</div>
					<Separator />
					<ul className="grid gap-4" aria-label="Notification types">
						{PUSH_TYPES.map((t) => {
							const info = PUSH_TYPE_INFO[t];
							const id = `${deviceId}-${t}`;
							return (
								<li key={t} className="flex items-start justify-between gap-4">
									<div className="grid gap-0.5">
										<Label htmlFor={id}>{info.label}</Label>
										<p className="text-xs text-muted-foreground">{info.hint}</p>
									</div>
									<Switch
										id={id}
										checked={!!data && !data.offTypes.includes(t)}
										disabled={!data}
										onCheckedChange={(on) => setType.mutate({ type: t, on })}
										data-testid={PUSH_TESTID.type}
										data-type={t}
									/>
								</li>
							);
						})}
					</ul>
					{data?.mutedTrips.length ? (
						<>
							<Separator />
							<div className="grid gap-2">
								<h3 className="text-sm font-medium">Muted trips</h3>
								<ul className="grid gap-1.5">
									{data.mutedTrips.map((t) => (
										<li
											key={t.id}
											className="flex items-center justify-between gap-3 text-sm"
											data-testid={PUSH_TESTID.mutedTrip}
											data-trip-id={t.id}
										>
											<span className="flex min-w-0 items-center gap-2">
												<BellOff className="size-3.5 shrink-0 text-muted-foreground" />
												<span className="truncate">{t.name}</span>
											</span>
											<Button
												size="xs"
												variant="ghost"
												onClick={() => unmute.mutate(t.id)}
											>
												Unmute
											</Button>
										</li>
									))}
								</ul>
							</div>
						</>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
