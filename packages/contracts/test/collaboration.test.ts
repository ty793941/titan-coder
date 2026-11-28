import { describe, expect, it } from "vitest";
import {
  assignmentCreateRequestSchema,
  reviewRequestCreateSchema,
  collaborationHandoffCreateRequestSchema,
  collaborationMemberRequestSchema,
  collaborationPageSchema,
  collaborationVersionRequestSchema,
} from "../src/collaboration.js";

describe("collaboration contracts", () => {
  it("rejects secrets and unknown fields in assignment requests", () => {
    expect(() =>
      assignmentCreateRequestSchema.parse({
        subjectType: "human",
        subjectId: "member-1",
        responsibility: "human-owner",
        reviewers: [],
        secret: "never-accepted",
      }),
    ).toThrow();
  });

  it("requires a supported review target and gate", () => {
    expect(() =>
      reviewRequestCreateSchema.parse({
        targetType: "prompt",
        targetId: "prompt-1",
        reviewerSubject: { subjectType: "human", subjectId: "member-1" },
        gate: "unknown",
        requiredDecision: "approve",
      }),
    ).toThrow();
  });
  it("accepts bounded valid assignments and rejects mismatched owner types", () => {
    const body = {
      subjectType: "human",
      subjectId: "member-1",
      responsibility: "human-owner",
      reviewers: [],
    };
    expect(assignmentCreateRequestSchema.parse(body)).toEqual(body);
    for (const changed of [
      { ...body, subjectType: "agent" },
      { ...body, responsibility: "agent-owner" },
      { ...body, dueAt: "tomorrow" },
      { ...body, reviewers: ["same", "same"] },
      { ...body, reviewers: Array.from({ length: 21 }, (_, i) => `m${i}`) },
    ])
      expect(assignmentCreateRequestSchema.safeParse(changed).success).toBe(
        false,
      );
  });
  it("rejects unsupported conditional reviews and actor impersonation", () => {
    const body = {
      projectId: "p",
      targetType: "task",
      targetId: "t",
      reviewerSubject: { subjectType: "human", subjectId: "m" },
      gate: "questions",
      requiredDecision: "approve",
    };
    expect(reviewRequestCreateSchema.parse(body).mode).toBe("serial");
    expect(
      reviewRequestCreateSchema.safeParse({ ...body, mode: "conditional" })
        .success,
    ).toBe(false);
    expect(
      collaborationPageSchema.safeParse({ projectId: "p", subjectId: "m" })
        .success,
    ).toBe(false);
    expect(
      collaborationMemberRequestSchema.safeParse({
        subjectType: "human",
        subjectId: "m",
        role: "owner",
        actor: "root",
      }).success,
    ).toBe(false);
  });
  it("requires a complete bounded handoff package and blocks pasted credentials", () => {
    const body = {
      toSubject: { subjectType: "human", subjectId: "m" },
      reason: "转交",
      openQuestions: [],
      risks: [],
      nextActions: [],
    };
    expect(collaborationHandoffCreateRequestSchema.parse(body)).toEqual(body);
    expect(
      collaborationHandoffCreateRequestSchema.safeParse({
        ...body,
        reason: "api_key=secret-example",
      }).success,
    ).toBe(false);
    expect(
      collaborationHandoffCreateRequestSchema.safeParse({
        ...body,
        nextActions: ["https://private.example"],
      }).success,
    ).toBe(false);
    expect(
      collaborationHandoffCreateRequestSchema.safeParse({
        ...body,
        risks: undefined,
      }).success,
    ).toBe(false);
  });
  it("requires bounded positive versions and project-scoped pagination", () => {
    expect(
      collaborationVersionRequestSchema.safeParse({ expectedVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      collaborationVersionRequestSchema.safeParse({
        expectedVersion: 1,
        arbitrary: true,
      }).success,
    ).toBe(false);
    expect(
      collaborationPageSchema.parse({ projectId: "p", limit: "2" }),
    ).toMatchObject({ limit: 2, offset: 0, status: "pending" });
    expect(collaborationPageSchema.safeParse({}).success).toBe(false);
    expect(
      collaborationPageSchema.safeParse({ projectId: "p", limit: 101 }).success,
    ).toBe(false);
  });
});
