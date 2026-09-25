/**
 * QA security verifier (I2 round 1): SEC-05. A presigned PUT is limited to
 * one key under its trip, the signed type and length and a short expiry; a
 * presigned GET can't be bent to another key; finalize takes an id and only
 * the uploader's own. Direct S3 API calls with the URLs the app hands out.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { call, EMAIL, GG, MOD, memberPage, PQ, T } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
// A 1×1 JPEG.
const JPEG = Buffer.from(
	"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
	"base64",
);

test("presigned URLs are narrowly scoped", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const audrey = await memberPage(browser, EMAIL.audrey);
	const up = await call(audrey.page, MOD.media, "createUpload", {
		tripId: T, target: { kind: "node", nodeId: GG }, type: "image/jpeg", size: JPEG.length, name: "scope.jpg",
	});
	expect(up.ok, JSON.stringify(up)).toBe(true);
	const { id, url } = up.r as { id: string; url: string };
	const u = new URL(url);
	out.putKey = u.pathname;
	out.putExpires = u.searchParams.get("X-Amz-Expires");
	out.putSignedHeaders = u.searchParams.get("X-Amz-SignedHeaders");
	const req = audrey.page.request;
	const put = (target: string, body: Buffer, type = "image/jpeg") =>
		req.put(target, { data: body, headers: { "Content-Type": type } }).then((r) => r.status());
	// Another key in the same trip, and another trip, with the same signature.
	const otherKey = url.replace(`/${id}/original`, `/${id}/evil.html`);
	const otherTrip = url.replace(`trips/${T}/`, `trips/${PQ}/`);
	out.putOtherKey = await put(otherKey, JPEG);
	out.putOtherTrip = await put(otherTrip, JPEG);
	out.putWrongType = await put(url, JPEG, "text/html");
	out.putWrongLength = await put(url, Buffer.concat([JPEG, Buffer.from("xx")]));
	out.putOk = await put(url, JPEG);
	// Someone else can't finalize it; the uploader can.
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const steal = await call(dennis.page, MOD.media, "completeUpload", { id, hasPoster: false });
	out.completeByOther = steal.ok ? "OK" : steal.err;
	const done = await call(audrey.page, MOD.media, "completeUpload", { id, hasPoster: false });
	out.complete = done.ok ? "OK" : done.err;
	// Re-using the PUT after finalize (same type + length, different bytes: an HTML body).
	const html = Buffer.alloc(JPEG.length, 0x20);
	html.write("<html><script>alert(1)</script>");
	out.putAfterComplete = await put(url, html);
	// The object now served for the finished upload.
	const g = await req.get(`/media/${id}/original`, { maxRedirects: 0 });
	const loc = g.headers().location ?? "";
	out.getStatus = g.status();
	out.getExpires = loc ? new URL(loc).searchParams.get("X-Amz-Expires") : null;
	if (loc) {
		const body = await req.get(loc).then((r) => r.body());
		out.servedIsHtml = body.toString("latin1").includes("<script>");
		const lu = new URL(loc);
		out.getOtherKey = await req.get(loc.replace(`/${id}/original`, `/${id}/display.webp`)).then((r) => r.status());
		out.getOtherTrip = await req.get(loc.replace(`trips/${T}/`, `trips/${PQ}/`)).then((r) => r.status());
		out.anonymousList = await req.get(`${lu.origin}/${lu.pathname.split("/")[1]}/`).then((r) => r.status());
		out.anonymousGet = await req.get(`${lu.origin}${lu.pathname}`).then((r) => r.status());
	}
	writeFileSync(path.join(DIR, "upload.json"), JSON.stringify(out, null, 1));
	await audrey.ctx.close();
	await dennis.ctx.close();
});
