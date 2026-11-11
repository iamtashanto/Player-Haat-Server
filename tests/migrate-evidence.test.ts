import { beforeEach, describe, expect, it } from "vitest";
import { decryptEvidence } from "../src/lib/evidence-crypto.js";
import { migrateEvidenceToPrivate } from "../src/lib/storage/migrate-evidence.js";
import { fakeStorage } from "./fake-storage.js";
import { JPEG } from "./images.js";
import { prisma, recruiterUser, resetDb, seedWorld } from "./helpers.js";

let userId: string;
let requestId: string;
const PUBLIC = (n: string) => `playerhaat/test/verification-docs/u/${n}`;
beforeEach(async () => {
  await resetDb();
  const w = await seedWorld();
  const rec = await recruiterUser(w);
  userId = rec.user.id;
  for (const n of ["a", "b"]) fakeStorage.put(PUBLIC(n), 0, "verification-doc");
  const v = await prisma.verificationRequest.create({
    data: { kind: "RECRUITER", submitterId: userId, recruiterProfileId: rec.recruiterId!, evidenceLinks: [], evidenceImages: [{ url: `https://fake.cdn/${PUBLIC("a")}`, publicId: PUBLIC("a") }, { url: `https://fake.cdn/${PUBLIC("b")}`, publicId: PUBLIC("b") }] },
  });
  requestId = v.id;
});

const deps = (over: Partial<Parameters<typeof migrateEvidenceToPrivate>[0]> = {}) => ({
  dryRun: false,
  fetchImage: async () => JPEG,
  putText: (t: string, o: { folder: string; name: string }) => fakeStorage.putText(t, o),
  deletePublic: (id: string) => fakeStorage.deleteImage(id),
  ...over,
});

describe("evidence → private migration", () => {
  it("--dry-run counts and changes nothing", async () => {
    const r = await migrateEvidenceToPrivate(deps({ dryRun: true }));
    expect(r).toMatchObject({ requests: 1, found: 2, moved: 0 });
    expect(await prisma.verificationFile.count()).toBe(0);
    expect(fakeStorage.files.has(PUBLIC("a"))).toBe(true);
  });

  it("moves each file encrypted into verification/<userId>/, removes the public copies and clears the legacy list; a second run finds nothing", async () => {
    const r = await migrateEvidenceToPrivate(deps());
    expect(r).toMatchObject({ found: 2, moved: 2, failed: 0, publicCopiesDeleted: 2 });
    const files = await prisma.verificationFile.findMany({ where: { requestId } });
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.path.includes(`/verification/${userId}/`) && f.userId === userId)).toBe(true);
    expect(decryptEvidence(fakeStorage.texts.get(files[0]!.path)!, userId).equals(JPEG)).toBe(true);
    expect(fakeStorage.files.has(PUBLIC("a"))).toBe(false);
    expect(fakeStorage.files.has(PUBLIC("b"))).toBe(false);
    expect((await prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } })).evidenceImages).toBeNull();

    expect(await migrateEvidenceToPrivate(deps())).toMatchObject({ found: 0, moved: 0 });
    expect(await prisma.verificationFile.count()).toBe(2);
  });

  it("a failure keeps that entry (and its public copy) for the next run, and nothing is half-written", async () => {
    let n = 0;
    const r = await migrateEvidenceToPrivate(deps({ fetchImage: async () => { if (n++ === 0) throw new Error("download failed (404)"); return JPEG; } }));
    expect(r).toMatchObject({ found: 2, moved: 1, failed: 1 });
    expect(await prisma.verificationFile.count()).toBe(1);
    expect(fakeStorage.files.has(PUBLIC("a"))).toBe(true);
    expect(fakeStorage.files.has(PUBLIC("b"))).toBe(false);
    const left = await prisma.verificationRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(left.evidenceImages).toEqual([expect.objectContaining({ publicId: PUBLIC("a") })]);
    expect(await migrateEvidenceToPrivate(deps())).toMatchObject({ found: 1, moved: 1, failed: 0 });
    expect(await prisma.verificationFile.count()).toBe(2);
  });

  it("reports a public copy it could not delete (the private copy is safe) and refuses non-images", async () => {
    const lines: string[] = [];
    const r = await migrateEvidenceToPrivate(deps({ deletePublic: async () => { throw new Error("down"); }, log: (l) => lines.push(l) }));
    expect(r).toMatchObject({ moved: 2, publicCopiesDeleted: 0 });
    expect(lines.some((l) => l.startsWith("PUBLIC COPY NOT DELETED"))).toBe(true);
    await prisma.verificationRequest.update({ where: { id: requestId }, data: { evidenceImages: [{ url: "https://x/y", publicId: PUBLIC("c") }] } });
    expect(await migrateEvidenceToPrivate(deps({ fetchImage: async () => Buffer.from("<html>no</html>") }))).toMatchObject({ moved: 0, failed: 1 });
  });
});
