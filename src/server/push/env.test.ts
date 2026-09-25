import { describe, expect, it } from "vitest";
import { parsePushConfig } from "./env.server";

const PUB =
	"BL8nGtlMWTWHbho97EdCXL2AUtdNmErDGu9ACAvCLk-j_0Y0h4tqYtTUMutMo3NshvDRpjKskvzt5CYPLLiuASs";
const PRIV = "LHJAuFimLROyMAsa1zxQwx6JwE0UR1HSrRs5luubL-8";

describe("parsePushConfig", () => {
	it("push is simply off while the keys are unset", () => {
		expect(parsePushConfig({})).toEqual({ config: null });
		expect(
			parsePushConfig({ VAPID_PUBLIC_KEY: " ", VAPID_PRIVATE_KEY: "" }),
		).toEqual({ config: null });
	});

	it("on with all three", () => {
		expect(
			parsePushConfig({
				VAPID_PUBLIC_KEY: PUB,
				VAPID_PRIVATE_KEY: PRIV,
				VAPID_SUBJECT: "mailto:support@yonder.sh",
			}).config,
		).toEqual({
			publicKey: PUB,
			privateKey: PRIV,
			subject: "mailto:support@yonder.sh",
		});
	});

	it("half-configured or malformed: off, with a reason", () => {
		expect(
			parsePushConfig({ VAPID_PUBLIC_KEY: PUB, VAPID_PRIVATE_KEY: PRIV }),
		).toMatchObject({ config: null, problem: expect.stringMatching(/all of/) });
		expect(
			parsePushConfig({
				VAPID_PUBLIC_KEY: "short",
				VAPID_PRIVATE_KEY: PRIV,
				VAPID_SUBJECT: "mailto:a@b.c",
			}).config,
		).toBeNull();
		expect(
			parsePushConfig({
				VAPID_PUBLIC_KEY: PUB,
				VAPID_PRIVATE_KEY: PRIV,
				VAPID_SUBJECT: "support@yonder.sh",
			}).problem,
		).toMatch(/VAPID_SUBJECT/);
	});
});
