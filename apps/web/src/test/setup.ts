import "@testing-library/jest-dom/vitest";

// jsdom's own `localStorage` doesn't survive into this environment (Node's global `localStorage` is
// undefined without `--localstorage-file`, and it shadows jsdom's), so anything that persists a
// draft or a UI preference sees no storage at all here. The app treats that as a normal state — it
// wraps every access — but the tests that assert persistence need somewhere real to write, so a
// minimal in-memory implementation stands in.
if (!window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
}
