import argon2 from "argon2";
import type { PrismaClient } from "@prisma/client";

export const MIN_SEED_PASSWORD_LENGTH = 12;

export type SeedOptions = {
  /** Creates the ADMIN001 account when provided (min 12 characters). Never overwrites an existing admin. */
  adminPassword?: string;
  /** Development student accounts. Omit to seed no students. */
  students?: {
    /** Initial password shared by the NEWLY created accounts; they must change it on first login. */
    password: string;
    prefix: string;
    domain: string;
    count: number;
    streamCode: string;
  };
  /** Receives progress lines. Only ever given counts, never passwords, hashes or secrets. */
  log?: (message: string) => void;
};

export type SeedSummary = {
  streams: number;
  adminCreated: boolean;
  studentsCreated: number;
  /** Students that already existed and were left completely untouched. */
  studentsExisting: number;
};

const STREAMS = [
  { code: "CSE", name: "Computer Science and Engineering" },
  { code: "DS", name: "Data Science" },
  { code: "CYBER", name: "Cybersecurity" },
  { code: "CS", name: "Computer Science" },
  { code: "MCE", name: "Master of Computer Engineering" }
] as const;

function assertStrongSeedPassword(password: string, label: string) {
  if (password.length < MIN_SEED_PASSWORD_LENGTH) {
    throw new Error(`${label} must be at least ${MIN_SEED_PASSWORD_LENGTH} characters.`);
  }
}

/**
 * Idempotent: safe to run any number of times.
 *   - existing streams, the admin and every existing student are left exactly as they are
 *     (no renames, no re-activation, no password resets, no stream moves);
 *   - only missing records are created.
 * There is no default password: students are created only when a password is supplied by the caller.
 */
export async function seedDatabase(prisma: PrismaClient, options: SeedOptions = {}): Promise<SeedSummary> {
  const log = options.log ?? (() => {});
  const summary: SeedSummary = { streams: 0, adminCreated: false, studentsCreated: 0, studentsExisting: 0 };

  // Validate before writing anything so a bad password cannot leave a half-seeded database.
  if (options.adminPassword !== undefined) assertStrongSeedPassword(options.adminPassword, "Admin seed password");
  if (options.students) assertStrongSeedPassword(options.students.password, "Student seed password");

  const streamIdByCode = new Map<string, string>();
  for (const stream of STREAMS) {
    const row = await prisma.stream.upsert({ where: { code: stream.code }, update: {}, create: stream });
    streamIdByCode.set(stream.code, row.id);
    summary.streams++;
  }
  log(`Streams ensured: ${summary.streams}.`);

  if (options.adminPassword) {
    const existing = await prisma.user.findUnique({ where: { studentId: "ADMIN001" } });
    if (!existing) {
      await prisma.user.create({
        data: {
          studentId: "ADMIN001",
          fullName: "System Administrator",
          role: "ADMIN",
          passwordHash: await argon2.hash(options.adminPassword),
          mustChangePassword: true
        }
      });
      summary.adminCreated = true;
    }
    log(summary.adminCreated ? "Admin account created." : "Admin account already exists; left unchanged.");
  } else {
    log("No admin seed password provided: no admin account created.");
  }

  const spec = options.students;
  if (!spec) {
    log("No student seed password provided: no student accounts created.");
    return summary;
  }
  const streamId = streamIdByCode.get(spec.streamCode);
  if (!streamId) throw new Error(`Unknown seed stream code "${spec.streamCode}".`);

  for (let i = 1; i <= spec.count; i++) {
    const studentId = `${spec.prefix}${String(i).padStart(3, "0")}@${spec.domain}`;
    const existing = await prisma.user.findUnique({ where: { studentId }, select: { id: true } });
    if (existing) {
      summary.studentsExisting++;
      continue;
    }
    try {
      await prisma.user.create({
        data: {
          studentId,
          fullName: `Student ${spec.prefix}${String(i).padStart(3, "0")}`,
          role: "STUDENT",
          streamId,
          passwordHash: await argon2.hash(spec.password),
          mustChangePassword: true,
          isActive: true
        }
      });
      summary.studentsCreated++;
    } catch (err) {
      // A concurrent seed run created it first: that is fine, it must stay untouched.
      if ((err as { code?: string })?.code === "P2002") summary.studentsExisting++;
      else throw err;
    }
  }
  log(`Students: ${summary.studentsCreated} created, ${summary.studentsExisting} already existed and were left untouched.`);
  return summary;
}
