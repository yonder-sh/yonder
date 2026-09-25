/**
 * Engine results depend only on explicit IANA zones, never on the host's zone.
 * Every engine test imports this module FIRST, so the whole file runs with the
 * process zone set to UTC+14 (as `spikes/core` did through its vitest config).
 * Node applies a runtime `process.env.TZ` change to `Date` immediately.
 */
export const HOST_TZ = "Pacific/Kiritimati";
process.env.TZ = HOST_TZ;
