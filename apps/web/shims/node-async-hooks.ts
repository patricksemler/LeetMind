/**
 * Browser build shim for `node:async_hooks`. `@leetmind/shared/src/logger.ts` (pulled in
 * transitively by the barrel `@leetmind/shared` export web code imports for types) instantiates
 * an `AsyncLocalStorage` at module scope for server-side log correlation — dead weight in a
 * browser bundle, but a real top-level side effect Rollup can't tree-shake around, and Vite's
 * default `node:*` externalization for browser builds leaves no named export to satisfy the
 * import. This is a structural, never-actually-exercised stand-in so the build resolves; no
 * `apps/web` code imports or calls it directly. Scoped entirely to this app's Vite config —
 * `packages/shared` itself is untouched.
 */
export class AsyncLocalStorage<T> {
  private store: T | undefined;

  run<R>(store: T, fn: () => R): R {
    const previous = this.store;
    this.store = store;
    try {
      return fn();
    } finally {
      this.store = previous;
    }
  }

  getStore(): T | undefined {
    return this.store;
  }

  enterWith(store: T): void {
    this.store = store;
  }
}
