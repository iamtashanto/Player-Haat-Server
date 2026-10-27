/** Docker `db-test` service by default; override with TEST_DATABASE_URL to use any local Postgres. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://playerhaat:playerhaat@localhost:5443/playerhaat_test?schema=public";

/** Tests TRUNCATE tables, so refuse anything that isn't obviously a throwaway database. */
export function assertTestDatabase(url: string) {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run tests against database "${name}": its name must end with "_test".`);
  }
}
