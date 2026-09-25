import { describe, expect, it } from "vitest";
import {
	canEdit,
	deriveConnectionStatus,
	OFFLINE_AFTER_MS,
} from "./connection";

describe("deriveConnectionStatus", () => {
	const t0 = 1_000_000;
	it("follows SPEC §10.7", () => {
		expect(
			deriveConnectionStatus(
				{ status: "connected", everConnected: true, downSince: null },
				true,
				t0,
			),
		).toBe("live");
		expect(
			deriveConnectionStatus(
				{ status: "connecting", everConnected: false, downSince: t0 },
				true,
				t0 + 100,
			),
		).toBe("connecting");
		expect(
			deriveConnectionStatus(
				{ status: "disconnected", everConnected: true, downSince: t0 },
				true,
				t0 + 5_000,
			),
		).toBe("reconnecting");
		expect(
			deriveConnectionStatus(
				{ status: "connecting", everConnected: true, downSince: t0 },
				true,
				t0 + OFFLINE_AFTER_MS + 1,
			),
		).toBe("offline");
		expect(
			deriveConnectionStatus(
				{ status: "connected", everConnected: true, downSince: null },
				false,
				t0,
			),
		).toBe("offline");
	});

	it("canEdit needs an editing role and a connection", () => {
		expect(canEdit("editor", "live", true)).toBe(true);
		expect(canEdit("owner", "reconnecting", true)).toBe(true);
		expect(canEdit("viewer", "live", true)).toBe(false);
		expect(canEdit("editor", "offline", true)).toBe(false);
		expect(canEdit("editor", "live", false)).toBe(false);
		expect(canEdit(null, "live", true)).toBe(false);
	});
});
