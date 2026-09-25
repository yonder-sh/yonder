/**
 * I2 "content" verifier: signs the QA users in against this verifier's own
 * server (APP_URL) and keeps their storageStates in QA_AUTH_DIR, so the shared
 * e2e/.auth files of other agents are never touched.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

const AUTH = process.env.QA_AUTH_DIR ?? "";
const USERS = {
	dennis: ["dennis@asia2027.test", "Dennis", "Tester"],
	audrey: ["audrey@asia2027.test", "Audrey", "Tester"],
	kai: ["kai@asia2027.test", "Kai", "Viewer"],
	eve: ["eve@asia2027.test", "Eve", "Outsider"],
	maya: ["maya@asia2027.test", "Maya", "Chen"],
} as const;

test("sign in the QA users", async ({ playwright }) => {
	test.skip(!AUTH, "QA_AUTH_DIR unset");
	mkdirSync(AUTH, { recursive: true });
	for (const [handle, [email, first, last]] of Object.entries(USERS)) {
		const ctx = await playwright.request.newContext({ baseURL: process.env.APP_URL });
		await loginViaApi(ctx, email, { first, last });
		await ctx.storageState({ path: path.join(AUTH, `${handle}.json`) });
		await ctx.dispose();
	}
});
