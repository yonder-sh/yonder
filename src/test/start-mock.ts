/**
 * A stand-in for `@tanstack/react-start` in DB tests of server functions.
 *
 *   vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
 *   vi.mock("@tanstack/react-start/server", () => import("@/test/start-server-mock"));
 *
 * `createServerFn(...).validator(schema).handler(fn)` becomes a plain async
 * function `({ data, context }) => fn({ data: schema.parse(data), context })`:
 * the real validator and the real handler body run against the real database,
 * and the test passes `context.user` itself (the middleware — session lookup,
 * name and account checks — has its own tests). Middleware builders are inert.
 */
type Validator = { parse: (v: unknown) => unknown } | ((v: unknown) => unknown);
type Handler = (ctx: { data: unknown; context: unknown }) => unknown;

function builder(validator?: Validator) {
	const self = {
		middleware: () => self,
		validator: (v: Validator) => builder(v),
		inputValidator: (v: Validator) => builder(v),
		handler: (fn: Handler) => {
			const call = async (opts: { data?: unknown; context?: unknown } = {}) => {
				const data =
					validator === undefined
						? opts.data
						: typeof validator === "function"
							? validator(opts.data)
							: validator.parse(opts.data);
				return fn({ data, context: opts.context ?? {} });
			};
			return Object.assign(call, { method: "POST" });
		},
	};
	return self;
}

export const createServerFn = (_opts?: unknown) => builder();

function middlewareBuilder(): Record<string, unknown> {
	const self: Record<string, unknown> = {};
	self.middleware = () => self;
	self.server = () => self;
	self.client = () => self;
	self.validator = () => self;
	self.inputValidator = () => self;
	return self;
}

export const createMiddleware = (_opts?: unknown) => middlewareBuilder();
export const createCsrfMiddleware = (_opts?: unknown) => middlewareBuilder();
export const createStart = (fn: unknown) => ({ getOptions: fn });
export const createIsomorphicFn = () => ({
	server: (f: unknown) => f,
	client: () => ({}),
});
export const createServerOnlyFn = <T>(f: T) => f;
export const createClientOnlyFn = <T>(f: T) => f;
