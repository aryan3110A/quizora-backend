import argon2 from "argon2";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { MIN_SEED_PASSWORD_LENGTH, seedDatabase } from "../../prisma/seedLogic";
import { describeDb } from "../helpers/db";

const DOMAIN = "seedtest.example";
const PASSWORD = "dev-only-seed-password-123";
const spec = (prefix: string, count = 3, password = PASSWORD) => ({ password, prefix, domain: DOMAIN, count, streamCode: "MCE" });
const idOf = (prefix: string, n: number) => `${prefix}${String(n).padStart(3, "0")}@${DOMAIN}`;

async function removeSeedData() {
  await prisma.user.deleteMany({ where: { OR: [{ studentId: { endsWith: `@${DOMAIN}` } }, { studentId: "ADMIN001" }] } });
}

describeDb("seed security and idempotency", () => {
  beforeEach(removeSeedData);
  afterAll(removeSeedData);

  it("creates students with the environment-provided password and NOT with their student ID", async () => {
    const summary = await seedDatabase(prisma, { students: spec("SEEDA") });
    expect(summary).toMatchObject({ studentsCreated: 3, studentsExisting: 0 });
    const user = await prisma.user.findUniqueOrThrow({ where: { studentId: idOf("SEEDA", 1) }, include: { stream: true } });
    expect(await argon2.verify(user.passwordHash, PASSWORD)).toBe(true);
    expect(await argon2.verify(user.passwordHash, user.studentId)).toBe(false); // the old insecure default is gone
    expect(user).toMatchObject({ role: "STUDENT", mustChangePassword: true, isActive: true });
    expect(user.stream?.code).toBe("MCE");
  });

  it("creates NO students when no password is supplied (there is no default password)", async () => {
    const summary = await seedDatabase(prisma, {});
    expect(summary.studentsCreated).toBe(0);
    expect(await prisma.user.count({ where: { studentId: { endsWith: `@${DOMAIN}` } } })).toBe(0);
    expect(await prisma.user.count({ where: { studentId: "ADMIN001" } })).toBe(0);
  });

  it("is idempotent: a second run creates nothing and changes nothing", async () => {
    await seedDatabase(prisma, { adminPassword: "an-admin-password-123", students: spec("SEEDB") });
    const before = await prisma.user.findMany({ where: { OR: [{ studentId: { endsWith: `@${DOMAIN}` } }, { studentId: "ADMIN001" }] }, orderBy: { studentId: "asc" } });
    const again = await seedDatabase(prisma, { adminPassword: "an-admin-password-123", students: spec("SEEDB") });
    expect(again).toMatchObject({ adminCreated: false, studentsCreated: 0, studentsExisting: 3 });
    const after = await prisma.user.findMany({ where: { OR: [{ studentId: { endsWith: `@${DOMAIN}` } }, { studentId: "ADMIN001" }] }, orderBy: { studentId: "asc" } });
    expect(after).toEqual(before); // including every updatedAt: nothing was written
  });

  it("never overwrites an existing student's name, status, stream, password or admin password on re-seed", async () => {
    await seedDatabase(prisma, { adminPassword: "an-admin-password-123", students: spec("SEEDC") });
    const customHash = await argon2.hash("the-students-own-password");
    const otherStream = await prisma.stream.findUniqueOrThrow({ where: { code: "CSE" } });
    await prisma.user.update({
      where: { studentId: idOf("SEEDC", 2) },
      data: { fullName: "Renamed By Admin", isActive: false, passwordHash: customHash, streamId: otherStream.id, mustChangePassword: false }
    });
    const adminHash = await argon2.hash("the-admins-own-password");
    await prisma.user.update({ where: { studentId: "ADMIN001" }, data: { passwordHash: adminHash } });

    await seedDatabase(prisma, { adminPassword: "a-different-admin-password", students: spec("SEEDC", 3, "a-different-seed-password") });

    const student = await prisma.user.findUniqueOrThrow({ where: { studentId: idOf("SEEDC", 2) } });
    expect(student).toMatchObject({ fullName: "Renamed By Admin", isActive: false, passwordHash: customHash, streamId: otherStream.id, mustChangePassword: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { studentId: "ADMIN001" } })).passwordHash).toBe(adminHash);
  });

  it("only fills in what is missing on a later run", async () => {
    await seedDatabase(prisma, { students: spec("SEEDD", 2) });
    const again = await seedDatabase(prisma, { students: spec("SEEDD", 4) });
    expect(again).toMatchObject({ studentsCreated: 2, studentsExisting: 2 });
  });

  it("rejects a weak password up front, before writing anything", async () => {
    const short = "x".repeat(MIN_SEED_PASSWORD_LENGTH - 1);
    await expect(seedDatabase(prisma, { students: spec("SEEDE", 2, short) })).rejects.toThrow(/at least/);
    await expect(seedDatabase(prisma, { adminPassword: short })).rejects.toThrow(/at least/);
    expect(await prisma.user.count({ where: { OR: [{ studentId: { endsWith: `@${DOMAIN}` } }, { studentId: "ADMIN001" }] } })).toBe(0);
  });

  it("never prints or returns passwords, hashes or secrets", async () => {
    const adminPassword = "a-very-secret-admin-password";
    const lines: string[] = [];
    const written: string[] = [];
    const spies = [
      vi.spyOn(console, "log").mockImplementation((...args) => void written.push(args.join(" "))),
      vi.spyOn(console, "error").mockImplementation((...args) => void written.push(args.join(" "))),
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (written.push(String(chunk)), true))
    ];
    let summary;
    try {
      summary = await seedDatabase(prisma, { adminPassword, students: spec("SEEDF", 2), log: (m) => lines.push(m) });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const everything = JSON.stringify({ lines, written, summary });
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(adminPassword);
    expect(everything).not.toContain("$argon2");
    expect(lines.length).toBeGreaterThan(0);
  });
});
