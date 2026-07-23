import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Both test files run schema setup (`create table if not exists ...`)
    // against the same real Postgres in beforeAll; running files in parallel
    // races two concurrent "IF NOT EXISTS" creates against the same system
    // catalog row (pg_type_typname_nsp_index). Keep file execution serial.
    fileParallelism: false,
    // Starts the dedicated throwaway Postgres if it isn't already up. Without this the whole
    // suite silently SKIPS when the container is absent — see src/globalSetup.ts.
    globalSetup: ['./src/globalSetup.ts'],
  },
});
