// Unit tests for the test-database-isolation guard itself (docs/CONTRACTS.md §13). This is a
// safety device, so the rejection cases matter more than the acceptance cases — every one of
// them must throw loudly, never silently continue.
import { describe, expect, it } from "vitest";
import { assertTestDatabase, DEFAULT_TEST_DATABASE_URL, testDatabaseUrl } from "./testDb.js";

function urlWithDb(dbName: string): string {
  return `postgres://algolift:algolift@localhost:5432/${dbName}`;
}

describe("assertTestDatabase", () => {
  describe("accepts", () => {
    it("a database named exactly 'test'", () => {
      expect(() => assertTestDatabase(urlWithDb("test"))).not.toThrow();
    });

    it("a database name ending in '_test' (e.g. algolift_test)", () => {
      expect(() => assertTestDatabase(urlWithDb("algolift_test"))).not.toThrow();
    });

    it("a database name ending in '_test' with query params", () => {
      expect(() => assertTestDatabase(`${urlWithDb("algolift_test")}?sslmode=disable`)).not.toThrow();
    });
  });

  describe("rejects", () => {
    it("the development database name (algolift)", () => {
      expect(() => assertTestDatabase(urlWithDb("algolift"))).toThrow(/refusing to run destructive/i);
    });

    it("a database name that merely starts with 'test' as a prefix of another word (algolift_prod)", () => {
      expect(() => assertTestDatabase(urlWithDb("algolift_prod"))).toThrow(/refusing to run destructive/i);
    });

    it('a database name containing "test" but not as a "_test" suffix (testing_db)', () => {
      expect(() => assertTestDatabase(urlWithDb("testing_db"))).toThrow(/refusing to run destructive/i);
    });

    it("a URL with no database name at all (bare host, no path)", () => {
      expect(() => assertTestDatabase("postgres://algolift:algolift@localhost:5432")).toThrow(
        /no database name/i,
      );
    });

    it("a URL with no database name at all (trailing slash, empty path)", () => {
      expect(() => assertTestDatabase("postgres://algolift:algolift@localhost:5432/")).toThrow(
        /no database name/i,
      );
    });

    it("a malformed connection string", () => {
      expect(() => assertTestDatabase("not a url at all")).toThrow(/malformed/i);
    });

    it("an empty string", () => {
      expect(() => assertTestDatabase("")).toThrow(/malformed/i);
    });
  });
});

describe("testDatabaseUrl", () => {
  it("defaults to postgres://algolift:algolift@localhost:5432/algolift_test", () => {
    expect(DEFAULT_TEST_DATABASE_URL).toBe("postgres://algolift:algolift@localhost:5432/algolift_test");
  });

  it("returns TEST_DATABASE_URL when set, otherwise the default", () => {
    const original = process.env.TEST_DATABASE_URL;
    try {
      delete process.env.TEST_DATABASE_URL;
      expect(testDatabaseUrl()).toBe(DEFAULT_TEST_DATABASE_URL);

      process.env.TEST_DATABASE_URL = "postgres://algolift:algolift@localhost:5432/algolift_test";
      expect(testDatabaseUrl()).toBe("postgres://algolift:algolift@localhost:5432/algolift_test");
    } finally {
      if (original === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = original;
    }
  });
});
