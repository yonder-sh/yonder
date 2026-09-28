/**
 * No egress: refuses every connection and DNS query that would leave this
 * machine, for the e2e envs (`scripts/no-egress-preload.mjs`, loaded with
 * NODE_OPTIONS=--import) and vitest (`src/test/no-network.ts`).
 *
 * Hooks `net.Socket#connect`, which net, tls, http(s), http2, undici (Node's
 * fetch and the app's own) and every client library end in, and
 * `dns.lookup` / `dns.resolve*`. Loopback addresses, `localhost` and Unix
 * sockets pass; so do the `allow`ed `host` or `host:port` entries. A refused
 * connect fails like ECONNREFUSED, a refused lookup like ENOTFOUND, and
 * `onRefuse` hears about each (with the caller's stack). Installing again
 * only swaps `allow` and `onRefuse` (one hook per process).
 */
import dns from "node:dns";
import net from "node:net";

const KEY = Symbol.for("yonder.no-egress");

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("0.0.0.0", "ipv4");
loopback.addAddress("::1", "ipv6");
loopback.addAddress("::", "ipv6");

/** True for localhost names and loopback addresses (IPv4-mapped included). */
export function isLoopbackHost(host) {
	if (host === undefined || host === null || host === "") return true;
	let h = String(host)
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
	if (mapped) h = mapped[1];
	const family = net.isIP(h);
	if (family === 4) return loopback.check(h, "ipv4");
	if (family === 6) return loopback.check(h, "ipv6");
	return false;
}

/** `{ host, port }` a `Socket#connect(...)` call dials, or null for a pipe. */
function target(args) {
	let a = args[0];
	// net.connect/tls.connect pass their normalized [options, callback].
	if (Array.isArray(a)) a = a[0];
	if (a && typeof a === "object") {
		if (a.path) return null;
		return { host: a.host ?? a.hostname ?? "localhost", port: a.port };
	}
	if (typeof a === "string" && !/^\d+$/.test(a)) return null;
	return { host: typeof args[1] === "string" ? args[1] : "localhost", port: a };
}

function init() {
	const state = { allow: new Set(), onRefuse: () => {} };
	const passes = (host, port) =>
		isLoopbackHost(host) ||
		state.allow.has(String(host).toLowerCase()) ||
		(port !== undefined &&
			state.allow.has(`${String(host).toLowerCase()}:${port}`));
	const refuse = (kind, host, port, code) => {
		const limit = Error.stackTraceLimit;
		Error.stackTraceLimit = 30;
		const stack = (new Error().stack ?? "").split("\n").slice(3).join("\n");
		Error.stackTraceLimit = limit;
		try {
			state.onRefuse({
				kind,
				host: String(host),
				port: port === undefined ? undefined : Number(port),
				stack,
			});
		} catch {}
		const where = port === undefined ? host : `${host}:${port}`;
		return Object.assign(
			new Error(
				`no-egress: refused ${kind} to ${where} (tests never leave this machine)`,
			),
			{
				code,
				errno: code,
				syscall: kind === "connect" ? "connect" : "getaddrinfo",
				hostname: String(host),
			},
		);
	};

	const connect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function (...args) {
		const t = target(args);
		if (t && !passes(t.host, t.port)) {
			const err = refuse("connect", t.host, t.port, "ECONNREFUSED");
			process.nextTick(() => this.destroy(err));
			return this;
		}
		return connect.apply(this, args);
	};

	// DNS: a name that isn't local is never looked up (the query itself leaves).
	const named = (h) =>
		typeof h === "string" && !net.isIP(h.replace(/^\[|\]$/g, "")) && !passes(h);
	const lookup = dns.lookup;
	dns.lookup = function (hostname, options, callback) {
		const cb = typeof options === "function" ? options : callback;
		if (named(hostname) && typeof cb === "function") {
			const err = refuse("dns", hostname, undefined, "ENOTFOUND");
			process.nextTick(() => cb(err));
			return {};
		}
		return lookup.call(this, hostname, options, callback);
	};
	const lookupP = dns.promises.lookup;
	dns.promises.lookup = function (hostname, options) {
		if (named(hostname))
			return Promise.reject(refuse("dns", hostname, undefined, "ENOTFOUND"));
		return lookupP.call(this, hostname, options);
	};
	const wrapResolvers = (obj, promise) => {
		for (const name of Object.getOwnPropertyNames(obj)) {
			if (!/^(resolve|reverse)/.test(name) || typeof obj[name] !== "function")
				continue;
			const fn = obj[name];
			obj[name] = function (host, ...rest) {
				if (name === "reverse" || named(host)) {
					const err = refuse("dns", host, undefined, "ENOTFOUND");
					if (promise) return Promise.reject(err);
					const cb = rest.findLast((x) => typeof x === "function");
					if (cb) process.nextTick(() => cb(err));
					return undefined;
				}
				return fn.call(this, host, ...rest);
			};
		}
	};
	wrapResolvers(dns, false);
	wrapResolvers(dns.promises, true);
	wrapResolvers(dns.Resolver.prototype, false);
	wrapResolvers(dns.promises.Resolver.prototype, true);
	return state;
}

/** Installs the hooks once per process; later calls swap `allow` and `onRefuse`. */
export function installNoEgress(opts = {}) {
	process[KEY] ??= init();
	const state = process[KEY];
	state.allow = new Set((opts.allow ?? []).map((a) => String(a).toLowerCase()));
	state.onRefuse = opts.onRefuse ?? (() => {});
}
