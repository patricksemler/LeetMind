/**
 * The API's wire contract, as zod schemas plus the types inferred from them.
 *
 * Every response the app receives is parsed through these before it reaches a component (see
 * `src/lib/api.ts`) — this directory is the single place an API shape is declared, and nothing
 * under `src/` should ever redeclare one of these types by hand.
 */
export * from "./signature";
export * from "./concepts";
export * from "./problem";
export * from "./submission";
export * from "./hints";
export * from "./practice";
export * from "./api";
export * from "./events";
