import { execSync } from "node:child_process";
import { TEST_DATABASE_URL, assertTestDatabase } from "./test-db.js";

/** Once per run: make sure the test database exists and has every migration applied. */
export default function setup() {
  assertTestDatabase(TEST_DATABASE_URL);
  try {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: "pipe",
    });
  } catch (err) {
    const out = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
    throw new Error(
      `Could not migrate the test database (${TEST_DATABASE_URL}).\n` +
        `Start it with \`docker compose --profile test up -d db-test\` or set TEST_DATABASE_URL.\n\n${out}`,
    );
  }
}
