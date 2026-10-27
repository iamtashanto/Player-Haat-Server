import { vi } from "vitest";
import { TEST_DATABASE_URL, assertTestDatabase } from "./test-db.js";

// Runs before every test file. Never trust a developer's .env here: pin everything the app reads.
assertTestDatabase(TEST_DATABASE_URL);
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_ACCESS_SECRET = "test-secret-test-secret-test-secret-123";
process.env.GOOGLE_CLIENT_IDS = "test-google-client";
process.env.APPLE_CLIENT_IDS = "com.playerhaat.test";
process.env.SMTP_HOST = "";
process.env.PAYMENT_BKASH_NUMBER = "01700000000"; // so the manual mobile-banking flow can be exercised

vi.mock("../src/lib/mailer.js", async () => {
  const { mailbox } = await import("./mailbox.js");
  return {
    sendMail: async (msg: unknown) => {
      mailbox.push(msg as never);
    },
  };
});
vi.mock("../src/lib/storage/index.js", async () => {
  const { fakeStorage } = await import("./fake-storage.js");
  return { storage: fakeStorage };
});
vi.mock("../src/lib/push/index.js", async () => {
  const { fakePush } = await import("./fake-push.js");
  return { push: fakePush };
});
vi.mock("../src/lib/sms/index.js", async () => {
  const { fakeSms } = await import("./fake-sms.js");
  return { sms: fakeSms };
});
vi.mock("../src/lib/social/google.js", async () => {
  const { fakeVerify } = await import("./fake-social.js");
  return { verifyGoogleIdToken: fakeVerify("GOOGLE") };
});
vi.mock("../src/lib/social/apple.js", async () => {
  const { fakeVerify } = await import("./fake-social.js");
  return { verifyAppleIdentityToken: fakeVerify("APPLE") };
});
