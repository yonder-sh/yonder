// Setup for the Vitest "db" project (vitest.config.ts): refuse the main stack
// before a test file (or its hoisted env overrides) can open a connection.
import { assertIsolated } from "./isolation";

assertIsolated(process.env);
