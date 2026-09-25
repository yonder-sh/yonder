import { afterEach, describe, expect, it } from "vitest";
import {
	followCamera,
	isCameraFollowing,
	pauseCameraFollow,
	useCamFollow,
	visibleBox,
} from "./camera-follow";

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
const cam = {
	c: [135.5, 34.7] as [number, number],
	z: 9,
	b: 20,
	p: 30,
	g: false,
	w: 1000,
	h: 800,
	n: 1,
};

afterEach(() => {
	useCamFollow.setState({ leader: null, paused: false, leaderGlobe: null });
});

describe("visibleBox", () => {
	it("is the part of the map nothing covers", () => {
		// A 1440×900 map with a 400 px inspector on the right.
		expect(visibleBox(1440, 900, { ...NONE, right: 400 })).toEqual({
			cx: 520,
			cy: 450,
			w: 1040,
			h: 900,
		});
		// A phone: the sheet covers the bottom half, chrome the top.
		expect(visibleBox(390, 800, { ...NONE, top: 112, bottom: 400 })).toEqual({
			cx: 195,
			cy: 112 + 144,
			w: 390,
			h: 288,
		});
	});
	it("never gives the whole map up to an inset", () => {
		const b = visibleBox(300, 300, {
			top: 900,
			right: 900,
			bottom: 0,
			left: 0,
		});
		expect(b.w).toBeGreaterThanOrEqual(40);
		expect(b.h).toBeGreaterThanOrEqual(40);
	});
});

describe("followCamera (FB-22: fit the view, not the zoom number)", () => {
	it("mirrors centre, bearing and pitch; zooms by the size ratio", () => {
		const to = followCamera(cam, {
			W: 500,
			H: 800,
			inset: NONE,
			padding: NONE,
		});
		expect(to.center).toEqual(cam.c);
		expect(to.bearing).toBe(20);
		expect(to.pitch).toBe(30);
		expect(to.zoom).toBeCloseTo(8, 6); // half the width: one level out
		expect(to.offset).toEqual([0, 0]);
	});
	it("centres the leader's view in MY uncovered part (inspector on the right)", () => {
		const to = followCamera(cam, {
			W: 1440,
			H: 900,
			inset: { ...NONE, right: 440 },
			padding: NONE,
		});
		// Visible part 1000 wide: same zoom, centre shifted 220 px left.
		expect(to.zoom).toBeCloseTo(9, 6);
		expect(to.offset).toEqual([-220, 0]);
	});
	it("measures the offset from the camera's padded centre (the globe's padding)", () => {
		const to = followCamera(cam, {
			W: 1000,
			H: 800,
			inset: NONE,
			padding: { ...NONE, left: 200 },
		});
		// Padded centre is at x = 600; the visible centre at 500.
		expect(to.offset).toEqual([-100, 0]);
	});
});

describe("pause / resume", () => {
	it("pauses only while following someone, and resume clears it", () => {
		pauseCameraFollow();
		expect(useCamFollow.getState().paused).toBe(false);
		useCamFollow.getState().setLeader({ id: "u1", name: "Dennis K" }, true);
		expect(isCameraFollowing()).toBe(true);
		pauseCameraFollow();
		expect(isCameraFollowing()).toBe(false);
		// The same leader again keeps the pause; a new one starts fresh.
		useCamFollow.getState().setLeader({ id: "u1", name: "Dennis K" }, false);
		expect(useCamFollow.getState().paused).toBe(true);
		useCamFollow.getState().resume();
		expect(isCameraFollowing()).toBe(true);
		pauseCameraFollow();
		useCamFollow.getState().setLeader({ id: "u2", name: "Maya" }, false);
		expect(useCamFollow.getState().paused).toBe(false);
	});
});
