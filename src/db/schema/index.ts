// Drizzle schema barrel (SPEC §6): drizzle.config.ts, db.server.ts and Better
// Auth's `drizzleAdapter(db, { provider: 'pg', schema })` read every table and
// relation from here. Hand-written SQL that Drizzle can't express (the live
// sibling-slug index, the cycle trigger, the deferrable day-date constraint and
// the two column-list SET NULL FKs) is in drizzle/0001_tree_guards.sql (§6.4);
// the money FKs with column-list SET NULL are in drizzle/0003_money_fks.sql.
export * from "./auth";
export * from "./bundle";
export * from "./enums";
export * from "./misc";
export * from "./money";
export * from "./nodes";
export * from "./proposals";
export * from "./push";
export * from "./relations";
export * from "./timeline";
export * from "./trips";
