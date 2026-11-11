import "dotenv/config";
import argon2 from "argon2";
import { prisma } from "../src/lib/prisma";

async function main() {
  const cse = await prisma.stream.upsert({
    where: { code: "CSE" },
    update: { name: "Computer Science and Engineering" },
    create: { code: "CSE", name: "Computer Science and Engineering" }
  });
  await prisma.stream.upsert({
    where: { code: "DS" },
    update: { name: "Data Science" },
    create: { code: "DS", name: "Data Science" }
  });
  await prisma.stream.upsert({
    where: { code: "CYBER" },
    update: { name: "Cybersecurity" },
    create: { code: "CYBER", name: "Cybersecurity" }
  });
  await prisma.stream.upsert({
    where: { code: "CS" },
    update: { name: "Computer Science" },
    create: { code: "CS", name: "Computer Science" }
  });
  const mce = await prisma.stream.upsert({
    where: { code: "MCE" },
    update: { name: "Master of Computer Engineering" },
    create: { code: "MCE", name: "Master of Computer Engineering" }
  });

  const adminPassword = process.env.ADMIN_SEED_PASSWORD;
  if (adminPassword && adminPassword.length >= 12) {
    await prisma.user.upsert({
      where: { studentId: "ADMIN001" },
      update: {},
      create: {
        studentId: "ADMIN001",
        fullName: "System Administrator",
        role: "ADMIN",
        passwordHash: await argon2.hash(adminPassword),
        mustChangePassword: true
      }
    });
    console.log("Seeded ADMIN001.");
  } else {
    console.log("Streams seeded. Set ADMIN_SEED_PASSWORD (12+ characters) to create the initial admin.");
  }

  // Seed students 26MCE001@nirmauni.ac.in through 26MCE032@nirmauni.ac.in
  console.log("Seeding students 26MCE001@nirmauni.ac.in to 26MCE032@nirmauni.ac.in...");
  for (let i = 1; i <= 32; i++) {
    const num = String(i).padStart(3, "0");
    const studentId = `26MCE${num}@nirmauni.ac.in`;
    const initialPassword = studentId;
    const passwordHash = await argon2.hash(initialPassword);

    await prisma.user.upsert({
      where: { studentId },
      update: {
        fullName: `Student 26MCE${num}`,
        streamId: mce.id,
        isActive: true
      },
      create: {
        studentId,
        fullName: `Student 26MCE${num}`,
        role: "STUDENT",
        streamId: mce.id,
        passwordHash,
        mustChangePassword: true,
        isActive: true
      }
    });
  }
  console.log("Successfully seeded 32 students (26MCE001@nirmauni.ac.in - 26MCE032@nirmauni.ac.in) with stream MCE and initial password = student ID.");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
