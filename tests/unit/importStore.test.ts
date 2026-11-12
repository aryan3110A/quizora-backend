import { describe, expect, it } from "vitest";
import { MemoryImportPreviewStore, type ImportPreview } from "../../src/services/importStore";

const preview = (n = 1): ImportPreview => ({
  adminId: "admin-1",
  quizId: "quiz-1",
  questions: Array.from({ length: n }, (_, i) => ({
    question: `Q${i}`, optionA: "a", optionB: "b", optionC: "c", optionD: "d", correctAnswer: "A" as const, marks: 1, negativeMarks: 0, row: i + 2
  }))
});

describe("MemoryImportPreviewStore (single instance / local development)", () => {
  it("stores and returns a preview", async () => {
    const store = new MemoryImportPreviewStore();
    await store.put("t1", preview(3));
    expect((await store.get("t1"))?.questions).toHaveLength(3);
  });

  it("returns null for a token that was never stored", async () => {
    expect(await new MemoryImportPreviewStore().get("nope")).toBeNull();
    expect(await new MemoryImportPreviewStore().take("nope")).toBeNull();
  });

  it("expires previews after their TTL", async () => {
    let now = 1_000_000;
    const store = new MemoryImportPreviewStore(() => now);
    await store.put("t1", preview(), 900);
    now += 899_000;
    expect(await store.get("t1")).not.toBeNull();
    now += 2_000;
    expect(await store.get("t1")).toBeNull();
    expect(await store.take("t1")).toBeNull();
  });

  it("take() consumes: a preview can be confirmed only once", async () => {
    const store = new MemoryImportPreviewStore();
    await store.put("t1", preview());
    const results = await Promise.all([store.take("t1"), store.take("t1")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.get("t1")).toBeNull();
  });

  it("can be put back after a failed import so the admin can retry", async () => {
    const store = new MemoryImportPreviewStore();
    await store.put("t1", preview(2));
    const taken = await store.take("t1");
    await store.put("t1", taken as ImportPreview);
    expect((await store.get("t1"))?.questions).toHaveLength(2);
  });

  it("sweeps expired entries so abandoned previews do not accumulate", async () => {
    let now = 0;
    const store = new MemoryImportPreviewStore(() => now);
    for (let i = 0; i < 50; i++) await store.put(`old-${i}`, preview(), 10);
    now += 11_000;
    await store.put("fresh", preview(), 10);
    expect((store as unknown as { entries: Map<string, unknown> }).entries.size).toBe(1);
  });
});
