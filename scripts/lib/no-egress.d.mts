/** A connection or DNS query `installNoEgress` refused. */
export type Refusal = {
	kind: "connect" | "dns";
	host: string;
	port?: number;
	/** Where it came from (the caller's frames). */
	stack: string;
};

export function isLoopbackHost(host: string | undefined | null): boolean;

export function installNoEgress(opts?: {
	/** Extra `host` or `host:port` entries that may be dialled. */
	allow?: readonly string[];
	onRefuse?: (r: Refusal) => void;
}): void;
