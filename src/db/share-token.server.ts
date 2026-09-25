/**
 * Share-link tokens (SECURITY.md §2 and §13, SPEC §6.3 share_links).
 *
 * - The raw token is 32 CSPRNG bytes, base64url (43 chars, 256 bits).
 * - The database stores only `token_hash` = base64url(SHA-256(token)), which
 *   `redeemShareLink` looks up through the unique index, plus `token_prefix`
 *   for UI and logs. A slow KDF isn't needed at 256 bits of entropy.
 * - `token_sealed` is the raw token under AES-256-GCM with a key derived from a
 *   server secret (pass `BETTER_AUTH_SECRET`), so the owner's ShareDialog can
 *   show and copy the link again. A database dump alone reveals no usable link.
 *   Rotating the secret makes `openShareToken` return null: the dialog then
 *   offers "Reset link" instead of the copy button.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	hkdfSync,
	randomBytes,
} from "node:crypto";

export type ShareTokenColumns = {
	tokenHash: string;
	tokenPrefix: string;
	tokenSealed: string | null;
};

const PREFIX_LENGTH = 6;
const SEAL_VERSION = "v1";

/** base64url(SHA-256(token)): the value stored in and looked up by `share_links.token_hash`. */
export function hashShareToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("base64url");
}

/** A fresh raw token. Hand it to the owner once; store only `shareTokenColumns(token, secret)`. */
export function newShareToken(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * The `share_links` columns for a raw token. Without `secret` the token is
 * shown once only (`token_sealed` null).
 */
export function shareTokenColumns(
	token: string,
	secret?: string,
): ShareTokenColumns {
	return {
		tokenHash: hashShareToken(token),
		tokenPrefix: token.slice(0, PREFIX_LENGTH),
		tokenSealed: secret ? sealShareToken(token, secret) : null,
	};
}

function sealKey(secret: string): Buffer {
	if (!secret) throw new Error("share-token secret is empty");
	return Buffer.from(
		hkdfSync("sha256", secret, "yonder", "share-link-token/v1", 32),
	);
}

/** Encrypts a raw token for `share_links.token_sealed`: `v1.<iv>.<ciphertext>.<tag>` (base64url parts). */
export function sealShareToken(token: string, secret: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", sealKey(secret), iv);
	const ciphertext = Buffer.concat([
		cipher.update(token, "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return [SEAL_VERSION, iv, ciphertext, tag]
		.map((part) =>
			typeof part === "string" ? part : part.toString("base64url"),
		)
		.join(".");
}

/** Decrypts `token_sealed`; null if it is malformed, tampered with, or sealed under another secret. */
export function openShareToken(sealed: string, secret: string): string | null {
	const [version, iv, ciphertext, tag, ...rest] = sealed.split(".");
	if (version !== SEAL_VERSION || !iv || !ciphertext || !tag || rest.length) {
		return null;
	}
	try {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			sealKey(secret),
			Buffer.from(iv, "base64url"),
		);
		decipher.setAuthTag(Buffer.from(tag, "base64url"));
		return Buffer.concat([
			decipher.update(Buffer.from(ciphertext, "base64url")),
			decipher.final(),
		]).toString("utf8");
	} catch {
		return null;
	}
}
