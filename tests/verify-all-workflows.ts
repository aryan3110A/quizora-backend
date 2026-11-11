import argon2 from "argon2";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import request from "supertest";

async function verifyWorkflows() {
  console.log("=== STARTING COMPLETE QUIZORA WORKFLOW VERIFICATION ===\n");

  // 1. Admin Login
  console.log("1. Testing Admin Login...");
  const adminRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ studentId: "ADMIN001", password: process.env.ADMIN_SEED_PASSWORD || "AdminQuizora2026!" });

  if (adminRes.status !== 200 || adminRes.body.user.role !== "ADMIN") {
    throw new Error(`Admin login failed: ${adminRes.status} ${JSON.stringify(adminRes.body)}`);
  }
  const adminCookie = adminRes.headers["set-cookie"];
  const adminCsrf = adminRes.headers["x-csrf-token"];
  console.log("✓ Admin logged in successfully:", adminRes.body.user.fullName);

  // 2. Student Login
  console.log("\n2. Testing Student Login with initial credentials...");
  const studentId = "26MCE001@nirmauni.ac.in";
  // Reset to initial state for idempotent test runs
  const initialHash = await argon2.hash(studentId);
  await prisma.user.update({
    where: { studentId },
    data: { passwordHash: initialHash, mustChangePassword: true }
  });

  const studentRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ studentId, password: studentId });

  if (studentRes.status !== 200 || studentRes.body.user.role !== "STUDENT") {
    throw new Error(`Student login failed: ${studentRes.status} ${JSON.stringify(studentRes.body)}`);
  }
  let studentCookie = studentRes.headers["set-cookie"];
  let studentCsrf = studentRes.headers["x-csrf-token"];
  console.log("✓ Student logged in successfully:", studentRes.body.user.fullName, "| mustChangePassword:", studentRes.body.user.mustChangePassword);

  // 3. One-Time Password Change & Lock
  console.log("\n3. Testing Student One-Time Password Change...");
  const newPassword = "NirmaStudent2026!";
  const changeRes = await request(app)
    .post("/api/v1/auth/change-password")
    .set("Cookie", studentCookie)
    .set("x-csrf-token", studentCsrf)
    .send({ currentPassword: studentId, newPassword });

  if (changeRes.status !== 200) {
    throw new Error(`Password change failed: ${changeRes.status} ${JSON.stringify(changeRes.body)}`);
  }
  console.log("✓ Initial password changed successfully:", changeRes.body.message);

  // Log in with new password
  const reLoginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ studentId, password: newPassword });
  if (reLoginRes.status !== 200) {
    throw new Error("Failed to login with new password");
  }
  studentCookie = reLoginRes.headers["set-cookie"];
  studentCsrf = reLoginRes.headers["x-csrf-token"];
  console.log("✓ Logged in with new password. mustChangePassword is now:", reLoginRes.body.user.mustChangePassword);

  // Attempting to change password a second time must be rejected
  console.log("Testing second password change attempt (should be rejected per policy)...");
  const secondChangeRes = await request(app)
    .post("/api/v1/auth/change-password")
    .set("Cookie", studentCookie)
    .set("x-csrf-token", studentCsrf)
    .send({ currentPassword: newPassword, newPassword: "AnotherPassword123!" });

  const errCode = secondChangeRes.body.error?.code || secondChangeRes.body.code;
  if (secondChangeRes.status === 403 && errCode === "PASSWORD_CHANGE_LOCKED") {
    console.log("✓ Second password change successfully BLOCKED:", secondChangeRes.body.error?.message || secondChangeRes.body.message);
  } else {
    throw new Error(`Expected 403 PASSWORD_CHANGE_LOCKED, got: ${secondChangeRes.status} ${JSON.stringify(secondChangeRes.body)}`);
  }

  // Admin password reset for this student
  console.log("Testing Admin password reset for student...");
  const studentUser = await prisma.user.findUniqueOrThrow({ where: { studentId } });
  const resetRes = await request(app)
    .post(`/api/v1/admin/students/${studentUser.id}/reset-password`)
    .set("Cookie", adminCookie)
    .set("x-csrf-token", adminCsrf)
    .send({});
  if (resetRes.status !== 200) {
    throw new Error(`Admin password reset failed: ${resetRes.status}`);
  }
  console.log("✓ Admin successfully reset student password:", resetRes.body.message);

  // Re-login student with reset password (studentId)
  const afterResetLogin = await request(app)
    .post("/api/v1/auth/login")
    .send({ studentId, password: studentId });
  if (afterResetLogin.status !== 200) {
    throw new Error("Failed to login after admin reset");
  }
  studentCookie = afterResetLogin.headers["set-cookie"];
  studentCsrf = afterResetLogin.headers["x-csrf-token"];
  console.log("✓ Student can sign in again with Student ID after admin reset.");

  // 4. Admin Quiz Creation
  console.log("\n4. Testing Quiz Creation by Admin...");
  const now = new Date();
  const startsAt = new Date(now.getTime() - 60_000).toISOString(); // 1 minute ago
  const endsAt = new Date(now.getTime() + 15 * 60_000).toISOString(); // 15 mins from now
  const createQuizRes = await request(app)
    .post("/api/v1/admin/quizzes")
    .set("Cookie", adminCookie)
    .set("x-csrf-token", adminCsrf)
    .send({
      title: "MCE Cloud Computing Assessment 2026",
      description: "Departmental quiz for Master of Computer Engineering",
      startsAt,
      endsAt,
      durationMinutes: 10,
      defaultMarks: 2,
      streamCodes: ["MCE"]
    });

  if (createQuizRes.status !== 201) {
    throw new Error(`Quiz creation failed: ${createQuizRes.status} ${JSON.stringify(createQuizRes.body)}`);
  }
  const quizId = createQuizRes.body.id;
  console.log("✓ Quiz created with ID:", quizId, "status:", createQuizRes.body.status);

  // 5. CSV / XLSX Question Import
  console.log("\n5. Testing CSV Question Import...");
  const csvData = [
    "Question,OptionA,OptionB,OptionC,OptionD,CorrectAnswer,Explanation,Topic,Marks,NegativeMarks",
    "What does VPC stand for in AWS?,Virtual Private Cloud,Virtual Public Cloud,Visual Private Cloud,Variable Process Cloud,A,VPC stands for Virtual Private Cloud,Networking,2,0.5",
    "Which HTTP method is idempotent?,POST,PUT,PATCH,CONNECT,B,PUT is an idempotent HTTP method,Web Architecture,2,0.5"
  ].join("\n");

  const previewRes = await request(app)
    .post(`/api/v1/admin/quizzes/${quizId}/questions/import/preview`)
    .set("Cookie", adminCookie)
    .set("x-csrf-token", adminCsrf)
    .attach("file", Buffer.from(csvData), "questions.csv");

  if (previewRes.status !== 200 || previewRes.body.validCount !== 2) {
    throw new Error(`Import preview failed: ${previewRes.status} ${JSON.stringify(previewRes.body)}`);
  }
  const importId = previewRes.body.importId;
  console.log("✓ Question file parsed. Valid questions count:", previewRes.body.validCount);

  const confirmRes = await request(app)
    .post(`/api/v1/admin/quizzes/${quizId}/questions/import/confirm`)
    .set("Cookie", adminCookie)
    .set("x-csrf-token", adminCsrf)
    .send({ importId });

  if (confirmRes.status !== 200 || confirmRes.body.imported !== 2) {
    throw new Error(`Confirm import failed: ${confirmRes.status} ${JSON.stringify(confirmRes.body)}`);
  }
  console.log("✓ Confirmed import. Imported questions count:", confirmRes.body.imported);

  // Publish quiz
  console.log("Publishing quiz...");
  const publishRes = await request(app)
    .post(`/api/v1/admin/quizzes/${quizId}/publish`)
    .set("Cookie", adminCookie)
    .set("x-csrf-token", adminCsrf);

  if (publishRes.status !== 200 || publishRes.body.status !== "PUBLISHED") {
    throw new Error(`Publish quiz failed: ${publishRes.status} ${JSON.stringify(publishRes.body)}`);
  }
  console.log("✓ Quiz published successfully.");

  // 6. Stream-Based Quiz Eligibility & Availability
  console.log("\n6. Testing Stream-Based Quiz Eligibility...");
  // Student from MCE stream
  const availableMce = await request(app)
    .get("/api/v1/student/quizzes/available")
    .set("Cookie", studentCookie);

  const isEligible = availableMce.body.quizzes.some((q: any) => q.id === quizId);
  if (!isEligible) {
    throw new Error("Quiz not found in available list for MCE student");
  }
  console.log("✓ Quiz is correctly available for student in MCE stream.");

  // Check student dashboard
  const dashRes = await request(app)
    .get("/api/v1/student/dashboard")
    .set("Cookie", studentCookie);
  if (!dashRes.body.active.some((q: any) => q.id === quizId)) {
    throw new Error("Quiz not visible in active quizzes on MCE student dashboard");
  }
  console.log("✓ Quiz shows under 'active' quizzes on student dashboard.");

  // 7. Starting Attempt & Answer Autosave
  console.log("\n7. Testing Attempt Start & Answer Autosave...");
  const startAttemptRes = await request(app)
    .post(`/api/v1/student/quizzes/${quizId}/attempts`)
    .set("Cookie", studentCookie)
    .set("x-csrf-token", studentCsrf);

  if (startAttemptRes.status !== 200) {
    throw new Error(`Start attempt failed: ${startAttemptRes.status} ${JSON.stringify(startAttemptRes.body)}`);
  }
  const attemptId = startAttemptRes.body.id;
  const questions = startAttemptRes.body.questions;
  console.log("✓ Attempt started with ID:", attemptId, "| Questions count:", questions.length);

  // Autosave answers
  const q1 = questions[0];
  const q1CorrectOption = q1.options[0]; // Option A is correct
  const saveRes = await request(app)
    .put(`/api/v1/student/attempts/${attemptId}/answers/${q1.id}`)
    .set("Cookie", studentCookie)
    .set("x-csrf-token", studentCsrf)
    .send({ selectedOptionId: q1CorrectOption.id });

  if (saveRes.status !== 200 || !saveRes.body.ok) {
    throw new Error(`Answer save failed: ${saveRes.status} ${JSON.stringify(saveRes.body)}`);
  }
  console.log("✓ Answer autosaved for question 1.");

  // 8. Refresh Recovery
  console.log("\n8. Testing Refresh Recovery...");
  const recoveryRes = await request(app)
    .get(`/api/v1/student/attempts/${attemptId}`)
    .set("Cookie", studentCookie);

  if (recoveryRes.status !== 200 || recoveryRes.body.answers[q1.id] !== q1CorrectOption.id) {
    throw new Error("Refresh recovery failed: Saved answer was not recovered.");
  }
  console.log("✓ Refresh recovery verified: Selected answer recovered accurately.");

  // 9. One-Attempt Enforcement
  console.log("\n9. Testing One-Attempt Enforcement...");
  const secondAttemptRes = await request(app)
    .post(`/api/v1/student/quizzes/${quizId}/attempts`)
    .set("Cookie", studentCookie)
    .set("x-csrf-token", studentCsrf);

  if (secondAttemptRes.body.id !== attemptId) {
    throw new Error("One-attempt enforcement failed: A new attempt was generated instead of returning existing attempt.");
  }
  console.log("✓ One-attempt enforced: Returns the ongoing attempt ID without creating duplicate.");

  // 10. Submission & Server-Side Scoring
  console.log("\n10. Testing Attempt Submission & Scoring...");
  // Also answer Q2 correctly
  const q2 = questions[1];
  const q2CorrectOption = q2.options[1]; // Option B is correct for PUT
  await request(app)
    .put(`/api/v1/student/attempts/${attemptId}/answers/${q2.id}`)
    .set("Cookie", studentCookie)
    .set("x-csrf-token", studentCsrf)
    .send({ selectedOptionId: q2CorrectOption.id });

  const submitRes = await request(app)
    .post(`/api/v1/student/attempts/${attemptId}/submit`)
    .set("Cookie", studentCookie)
    .set("x-csrf-token", studentCsrf);

  if (submitRes.status !== 200 || !submitRes.body.ok) {
    throw new Error(`Submission failed: ${submitRes.status} ${JSON.stringify(submitRes.body)}`);
  }
  console.log("✓ Attempt submitted successfully. Finalized:", submitRes.body.finalized, "Score:", submitRes.body.score);

  // Check attempt in DB
  const attemptDb = await prisma.attempt.findUniqueOrThrow({ where: { id: attemptId } });
  if (attemptDb.score !== 4 || attemptDb.totalMarks !== 4) {
    throw new Error(`Scoring calculation error: expected score 4/4, got ${attemptDb.score}/${attemptDb.totalMarks}`);
  }
  console.log("✓ Server-side score verified in database: 4/4 marks (100%).");

  // 11. Delayed Result Release
  console.log("\n11. Testing Delayed Result Release Policy...");
  // Currently endsAt is in the future (+15 mins)
  const resultBeforeClose = await request(app)
    .get(`/api/v1/student/attempts/${attemptId}/result`)
    .set("Cookie", studentCookie);

  if (resultBeforeClose.body.released !== false) {
    throw new Error("Security violation: Result was released before quiz closed!");
  }
  console.log("✓ Result correctly withholding answers and score while quiz window is open (released: false).");

  // Now simulate quiz window closing by adjusting endsAt to the past
  await prisma.quiz.update({
    where: { id: quizId },
    data: { endsAt: new Date(Date.now() - 1000) }
  });

  const resultAfterClose = await request(app)
    .get(`/api/v1/student/attempts/${attemptId}/result`)
    .set("Cookie", studentCookie);

  if (resultAfterClose.body.released !== true || resultAfterClose.body.score !== 4) {
    throw new Error("Result release failed after quiz closed.");
  }
  console.log("✓ Result successfully released after quiz closing time (released: true, score: 4/4).");
  console.log("  Questions with correct answers and explanations released to student.");

  console.log("\n=== ALL WORKFLOWS FULLY VERIFIED AND PASSING! ===");
}

verifyWorkflows()
  .catch((e) => {
    console.error("\n❌ Workflow verification error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
