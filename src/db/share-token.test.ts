import { describe, expect, it } from "vitest";
import {
	hashShareToken,
	newShareToken,
	openShareToken,
	sealShareToken,
	shareTokenColumns,
} from "./share-token.server";

const SECRET = "test-secret-that-is-long-enough-000000";

describe("share tokens", () => {
	it("makes 256-bit base64url tokens", () => {
		const token = newShareToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(newShareToken()).not.toBe(token);
	});

	it("hashes deterministically to 43 base64url chars (the DB CHECK)", () => {
		const hash = hashShareToken("dev-share-token-editor");
		expect(hash).toHaveLength(43);
		expect(hash).toBe(hashShareToken("dev-share-token-editor"));
		expect(hash).not.toBe(hashShareToken("dev-share-token-viewer"));
	});

	it("never stores the raw token", () => {
		const token = newShareToken();
		const cols = shareTokenColumns(token, SECRET);
		expect(cols.tokenPrefix).toBe(token.slice(0, 6));
		expect(cols.tokenHash).not.toContain(token);
		expect(cols.tokenSealed).not.toContain(token);
		expect(shareTokenColumns(token).tokenSealed).toBeNull();
	});

	it("seals and opens with the same secret only", () => {
		const token = newShareToken();
		const sealed = sealShareToken(token, SECRET);
		expect(openShareToken(sealed, SECRET)).toBe(token);
		expect(openShareToken(sealed, `${SECRET}-rotated`)).toBeNull();
		const [version, iv, ciphertext = "", tag] = sealed.split(".");
		const flipped = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
		expect(
			openShareToken([version, iv, flipped, tag].join("."), SECRET),
		).toBeNull();
		expect(openShareToken("garbage", SECRET)).toBeNull();
	});
});
