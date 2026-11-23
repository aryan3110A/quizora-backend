/**
 * Pure scoring logic for an examination attempt.
 *
 * This is the single source of truth for scoring. It was previously duplicated in the
 * submit handler and in `finalizeAttempt` (routes/student.ts). The rules are unchanged:
 *   - every question's marks count towards `totalMarks` (answered or not)
 *   - the selected option equals the correct option  -> + marks
 *   - an option was selected but it is wrong          -> - negativeMarks
 *   - unanswered                                       -> 0
 *   - the final score never goes below 0
 */
export type ScorableQuestion = {
  id: string;
  marks: number;
  negativeMarks: number;
  options: ReadonlyArray<{ id: string; isCorrect: boolean }>;
};

export type ScorableAnswer = {
  questionId: string;
  selectedOptionId: string | null;
};

export type ScoreResult = { score: number; totalMarks: number };

export type Scorer = (questions: ReadonlyArray<ScorableQuestion>, answers: ReadonlyArray<ScorableAnswer>) => ScoreResult;

export const scoreAttempt: Scorer = (questions, answers) => {
  const selectedByQuestion = new Map<string, string | null>();
  for (const answer of answers) selectedByQuestion.set(answer.questionId, answer.selectedOptionId);

  let score = 0;
  let totalMarks = 0;
  for (const question of questions) {
    totalMarks += question.marks;
    const selected = selectedByQuestion.get(question.id);
    const correct = question.options.find((option) => option.isCorrect);
    if (selected && correct && selected === correct.id) score += question.marks;
    else if (selected) score -= question.negativeMarks;
  }
  return { score: Math.max(0, score), totalMarks };
};
