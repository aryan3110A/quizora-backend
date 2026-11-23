import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { MIN_SEED_PASSWORD_LENGTH, seedDatabase } from "./seedLogic";

/**
 * Development seed. Credentials come ONLY from the environment and are never printed:
 *   ADMIN_SEED_PASSWORD      creates ADMIN001 when set (min 12 chars)
 *   SEED_STUDENT_PASSWORD    creates the development students when set (min 12 chars); they must change it on first login
 *   SEED_STUDENT_PREFIX / SEED_STUDENT_DOMAIN / SEED_STUDENT_COUNT / SEED_STUDENT_STREAM   optional (26MCE / nirmauni.ac.in / 32 / MCE)
 *   SEED_STUDENTS_IN_PRODUCTION=true   required to seed students when NODE_ENV=production
 * Re-running is safe: existing records are never modified.
 */
async function main() {
  const studentPassword = process.env.SEED_STUDENT_PASSWORD;
  if (studentPassword && process.env.NODE_ENV === "production" && process.env.SEED_STUDENTS_IN_PRODUCTION !== "true") {
    throw new Error("Refusing to seed development students with NODE_ENV=production (set SEED_STUDENTS_IN_PRODUCTION=true to override).");
  }
  if (studentPassword && studentPassword.length < MIN_SEED_PASSWORD_LENGTH) {
    throw new Error(`SEED_STUDENT_PASSWORD must be at least ${MIN_SEED_PASSWORD_LENGTH} characters.`);
  }
  const count = Number(process.env.SEED_STUDENT_COUNT ?? 32);
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("SEED_STUDENT_COUNT must be an integer between 1 and 500.");

  await seedDatabase(prisma, {
    adminPassword: process.env.ADMIN_SEED_PASSWORD || undefined,
    students: studentPassword
      ? {
          password: studentPassword,
          prefix: process.env.SEED_STUDENT_PREFIX ?? "26MCE",
          domain: process.env.SEED_STUDENT_DOMAIN ?? "nirmauni.ac.in",
          count,
          streamCode: process.env.SEED_STUDENT_STREAM ?? "MCE"
        }
      : undefined,
    log: (message) => console.log(message)
  });
}

main()
  .catch((e: unknown) => {
    // Print the message only: error objects can carry connection details.
    console.error(e instanceof Error ? e.message : "Seed failed.");
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
