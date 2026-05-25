/**
 * TypeBox schemas for step-result validation.
 */

import { Type } from "typebox";

export const StepResultSchema = Type.Object({
  result: Type.Union([Type.Literal("success"), Type.Literal("error")]),
  message: Type.String({ description: "Human-readable summary of the step outcome" }),
  retryable: Type.Optional(
    Type.Boolean({ description: "Whether the error is retryable (only for error results)" })
  ),
  metadata: Type.Optional(
    Type.Object({
      service_dirs: Type.Optional(Type.Array(Type.String())),
    })
  ),
});

export const GateAnswerSchema = Type.Object({
  stepIndex: Type.Integer({ minimum: 0 }),
  chosenLabel: Type.String(),
  advance: Type.Boolean(),
  abort: Type.Optional(Type.Boolean()),
});
