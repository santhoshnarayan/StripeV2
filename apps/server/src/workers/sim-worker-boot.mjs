// Bootstrap for the sim worker. Written in .mjs so Node doesn't try to
// type-strip it (and beat tsx to the punch) when the worker thread spawns.
// Registers the tsx ESM loader, then imports the .ts worker entry. The
// parent (apps/server/src/lib/projections/sim-pool.ts) spawns this file.
import { register } from "tsx/esm/api";
register();
await import("./sim-worker.ts");
