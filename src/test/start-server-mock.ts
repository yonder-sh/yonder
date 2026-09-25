/**
 * `@tanstack/react-start/server` outside a request (see `start-mock.ts`):
 * everything that needs the request throws like it would in a script, and
 * the callers (`mutationMeta`, `withStatus`) already handle that.
 */
const noRequest = () => {
	throw new Error("no request in this test");
};
export const getRequest = noRequest;
export const getRequestHeaders = noRequest;
export const getRequestIP = () => undefined;
export const setResponseStatus = noRequest;
export const setResponseHeader = noRequest;
export const getResponseHeaders = noRequest;
