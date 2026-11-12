import pino from "pino";
import { env } from "../config/env";

/** Structured JSON logs on stdout (collected by CloudWatch in AWS). Silent under test. */
export const logger = pino({ name: "quizora", level: env.NODE_ENV === "test" ? "silent" : "info" });
