/**
 * Web Push (VAPID) configuration. Push is simply OFF while any of the three
 * variables is unset (or invalid): nothing is enqueued, the settings say
 * "not set up", and nothing else changes.
 *
 *   VAPID_PUBLIC_KEY   base64url P-256 public key (`pnpm vapid:keys`)
 *   VAPID_PRIVATE_KEY  base64url private key
 *   VAPID_SUBJECT      `mailto:support@yonder.sh` (or an https URL)
 */

export type PushConfig = {
	publicKey: string;
	privateKey: string;
	subject: string;
};

const B64URL = /^[A-Za-z0-9_-]+$/;

let memo: { config: PushConfig | null } | undefined;
let warned = false;

/** Parses the three variables; null (push off) unless all are set and valid. */
export function parsePushConfig(env: Record<string, string | undefined>): {
	config: PushConfig | null;
	problem?: string;
} {
	const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
	const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
	const subject = env.VAPID_SUBJECT?.trim() ?? "";
	if (!publicKey && !privateKey && !subject) return { config: null };
	if (!publicKey || !privateKey || !subject)
		return {
			config: null,
			problem:
				"set all of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT",
		};
	// 65-byte uncompressed point → 87 chars; 32-byte key → 43 chars.
	if (!B64URL.test(publicKey) || publicKey.length !== 87)
		return {
			config: null,
			problem: "VAPID_PUBLIC_KEY is not a base64url P-256 public key",
		};
	if (!B64URL.test(privateKey) || privateKey.length !== 43)
		return {
			config: null,
			problem: "VAPID_PRIVATE_KEY is not a base64url P-256 private key",
		};
	if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject))
		return {
			config: null,
			problem: "VAPID_SUBJECT must be a mailto: address or an https URL",
		};
	return { config: { publicKey, privateKey, subject } };
}

/** The process's push config (memoized), or null when push is off. */
export function pushConfig(): PushConfig | null {
	if (!memo) {
		const parsed = parsePushConfig(process.env);
		if (parsed.problem && !warned) {
			warned = true;
			console.warn(`[push] off: ${parsed.problem}`);
		}
		memo = { config: parsed.config };
	}
	return memo.config;
}

export function pushEnabled(): boolean {
	return pushConfig() !== null;
}

/** Tests only: read the environment again. */
export function resetPushConfig(): void {
	memo = undefined;
	warned = false;
}
