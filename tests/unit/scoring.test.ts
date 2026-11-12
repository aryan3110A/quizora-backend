import { describe, expect, it } from "vitest";
import { scoreAttempt, type ScorableQuestion } from "../../src/services/scoring";

function question(id: string, marks: number, negativeMarks: number, correct = "a"): ScorableQuestion {
  return {
    id,
    marks,
    negativeMarks,
    options: ["a", "b", "c", "d"].map((o) => ({ id: `${id}-${o}`, isCorrect: o === correct }))
  };
}

describe("scoreAttempt", () => {
  const questions = [question("q1", 2, 0.5), question("q2", 2, 0.5), question("q3", 4, 1)];

  it("awards full marks for correct answers and counts every question in totalMarks", () => {
    const result = scoreAttempt(questions, [
      { questionId: "q1", selectedOptionId: "q1-a" },
      { questionId: "q2", selectedOptionId: "q2-a" },
      { questionId: "q3", selectedOptionId: "q3-a" }
    ]);
    expect(result).toEqual({ score: 8, totalMarks: 8 });
  });

  it("subtracts negative marks for a wrong selection", () => {
    const result = scoreAttempt(questions, [
      { questionId: "q1", selectedOptionId: "q1-a" },
      { questionId: "q2", selectedOptionId: "q2-b" }
    ]);
    expect(result).toEqual({ score: 1.5, totalMarks: 8 });
  });

  it("gives zero for unanswered questions and for cleared (null) answers", () => {
    const result = scoreAttempt(questions, [
      { questionId: "q1", selectedOptionId: "q1-a" },
      { questionId: "q2", selectedOptionId: null }
    ]);
    expect(result).toEqual({ score: 2, totalMarks: 8 });
  });

  it("never returns a negative score", () => {
    const result = scoreAttempt(questions, [
      { questionId: "q1", selectedOptionId: "q1-b" },
      { questionId: "q2", selectedOptionId: "q2-c" },
      { questionId: "q3", selectedOptionId: "q3-d" }
    ]);
    expect(result).toEqual({ score: 0, totalMarks: 8 });
  });

  it("uses each question's own marks and negative marks", () => {
    const result = scoreAttempt(questions, [
      { questionId: "q3", selectedOptionId: "q3-a" },
      { questionId: "q1", selectedOptionId: "q1-d" }
    ]);
    expect(result).toEqual({ score: 3.5, totalMarks: 8 });
  });

  it("ignores answers for questions that are not part of the quiz", () => {
    const result = scoreAttempt(questions, [{ questionId: "other", selectedOptionId: "other-a" }]);
    expect(result).toEqual({ score: 0, totalMarks: 8 });
  });

  it("matches the legacy rule when a question has no correct option configured (a selection costs negative marks)", () => {
    const broken: ScorableQuestion = { id: "qx", marks: 2, negativeMarks: 1, options: [{ id: "qx-a", isCorrect: false }] };
    expect(scoreAttempt([question("q1", 2, 0.5), broken], [
      { questionId: "q1", selectedOptionId: "q1-a" },
      { questionId: "qx", selectedOptionId: "qx-a" }
    ])).toEqual({ score: 1, totalMarks: 4 });
  });

  it("scores an empty attempt as 0 of the total", () => {
    expect(scoreAttempt(questions, [])).toEqual({ score: 0, totalMarks: 8 });
  });
});
