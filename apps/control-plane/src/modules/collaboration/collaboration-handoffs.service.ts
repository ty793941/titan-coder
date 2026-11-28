import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  DomainError,
  collaborationHandoffCreateRequestSchema,
  collaborationVersionRequestSchema,
} from "@titan/contracts";
import {
  CollaborationContext,
  activeAssignments,
  checkVersion,
  view,
} from "./collaboration-context.js";

@Injectable()
export class CollaborationHandoffsService {
  constructor(
    @Inject(CollaborationContext)
    private readonly context: CollaborationContext,
  ) {}

  async create(assignmentId: string, input: unknown, key?: string) {
    const parsed = collaborationHandoffCreateRequestSchema.parse(input);
    key ??= parsed.idempotencyKey;
    if (!key || key.length > 200 || !key.trim())
      throw new DomainError("VALIDATION_FAILED", "需要Idempotency-Key");
    const requestKey = key;
    return this.context.database.db.transaction().execute(async (trx) => {
      const assignment = await trx
        .selectFrom("assignment")
        .selectAll()
        .where("id", "=", assignmentId)
        .executeTakeFirst();
      if (!assignment)
        throw new DomainError("COLLABORATION_NOT_FOUND", "分配不存在");
      await this.context.project(trx, assignment.project_id);
      const current = await trx
        .selectFrom("assignment")
        .selectAll()
        .where("id", "=", assignmentId)
        .executeTakeFirstOrThrow();
      const scope = `assignment:${assignmentId}:handoff`;
      const replay = await this.context.idempotency.read<
        Record<string, unknown>
      >(trx, scope, requestKey, parsed);
      if (replay) return replay;
      if (
        !activeAssignments.includes(current.status) ||
        !["human-owner", "agent-owner"].includes(current.responsibility)
      )
        throw new DomainError(
          "COLLABORATION_INVALID_STATE",
          "只能交接当前负责人",
        );
      if (
        (current.responsibility === "human-owner") !==
        (parsed.toSubject.subjectType === "human")
      )
        throw new DomainError(
          "COLLABORATION_INVALID_STATE",
          "不能通过交接改变人类与Agent责任类别",
        );
      if (
        current.subject_type === parsed.toSubject.subjectType &&
        current.subject_id === parsed.toSubject.subjectId
      )
        throw new DomainError("COLLABORATION_INVALID_STATE", "不能交接给自己");
      await this.context.member(
        trx,
        current.project_id,
        parsed.toSubject.subjectType,
        parsed.toSubject.subjectId,
      );
      const pending = await trx
        .selectFrom("handoff")
        .select("id")
        .where("from_assignment_id", "=", assignmentId)
        .where("status", "=", "pending_acceptance")
        .executeTakeFirst();
      if (pending)
        throw new DomainError(
          "COLLABORATION_HANDOFF_CONFLICT",
          "已有待接收交接",
        );
      if (parsed.contextArtifactId) {
        const item = await trx
          .selectFrom("work_item")
          .select("task_id")
          .where("id", "=", current.work_item_id)
          .executeTakeFirstOrThrow();
        const artifact = await trx
          .selectFrom("artifact")
          .select("artifact_id")
          .where("artifact_id", "=", parsed.contextArtifactId)
          .where("project_id", "=", current.project_id)
          .where("task_id", "=", item.task_id)
          .executeTakeFirst();
        if (!artifact)
          throw new DomainError(
            "COLLABORATION_NOT_FOUND",
            "上下文工件不属于此工作项",
          );
      }
      const row = await trx
        .insertInto("handoff")
        .values({
          id: `handoff_${randomUUID()}`,
          project_id: current.project_id,
          work_item_id: current.work_item_id,
          from_assignment_id: current.id,
          to_subject_type: parsed.toSubject.subjectType,
          to_subject_id: parsed.toSubject.subjectId,
          reason: parsed.reason,
          context_artifact_id: parsed.contextArtifactId ?? null,
          open_questions: JSON.stringify(parsed.openQuestions),
          risks: JSON.stringify(parsed.risks),
          next_actions: JSON.stringify(parsed.nextActions),
          resolved_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.context.inbox(
        trx,
        row.project_id,
        row.to_subject_type,
        row.to_subject_id,
        "handoff",
        row.id,
      );
      await this.context.record(
        trx,
        row.project_id,
        "handoff.requested",
        row.id,
        {
          handoffId: row.id,
          assignmentId,
          workItemId: row.work_item_id,
          toSubjectId: row.to_subject_id,
        },
      );
      const result = view(row);
      await this.context.idempotency.write(
        trx,
        scope,
        requestKey,
        parsed,
        result,
        201,
      );
      return result;
    });
  }

  async list(workItemId: string) {
    return (
      await this.context.database.db
        .selectFrom("handoff")
        .selectAll()
        .where("work_item_id", "=", workItemId)
        .orderBy("created_at", "desc")
        .orderBy("id")
        .limit(100)
        .execute()
    ).map(view);
  }

  async decide(id: string, action: "accepted" | "declined", input: unknown) {
    const parsed = collaborationVersionRequestSchema.parse(input);
    return this.context.database.db.transaction().execute(async (trx) => {
      const source = await trx
        .selectFrom("handoff")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!source)
        throw new DomainError("COLLABORATION_NOT_FOUND", "交接不存在");
      await this.context.project(trx, source.project_id);
      const row = await trx
        .selectFrom("handoff")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      await this.context.myAction(
        trx,
        row.project_id,
        row.to_subject_type,
        row.to_subject_id,
      );
      if (row.status === action && row.version === parsed.expectedVersion + 1)
        return view(row);
      checkVersion(row.version, parsed.expectedVersion);
      if (row.status !== "pending_acceptance")
        throw new DomainError("COLLABORATION_HANDOFF_CONFLICT", "交接已结束");
      let newAssignmentId: string | null = null;
      if (action === "accepted") {
        const previous = await trx
          .selectFrom("assignment")
          .selectAll()
          .where("id", "=", row.from_assignment_id)
          .executeTakeFirstOrThrow();
        if (!activeAssignments.includes(previous.status))
          throw new DomainError(
            "COLLABORATION_HANDOFF_CONFLICT",
            "原分配状态已变化",
          );
        await trx
          .updateTable("assignment")
          .set({
            responsibility: "observer",
            status: "superseded",
            version: previous.version + 1,
          })
          .where("id", "=", previous.id)
          .execute();
        newAssignmentId = `assignment_${randomUUID()}`;
        await trx
          .insertInto("assignment")
          .values({
            id: newAssignmentId,
            project_id: row.project_id,
            work_item_id: row.work_item_id,
            subject_type: row.to_subject_type,
            subject_id: row.to_subject_id,
            responsibility: previous.responsibility,
            status: "accepted",
            reviewers: JSON.stringify(previous.reviewers),
            due_at: previous.due_at,
          })
          .execute();
        const item = await trx
          .selectFrom("work_item")
          .selectAll()
          .where("id", "=", row.work_item_id)
          .executeTakeFirstOrThrow();
        await trx
          .updateTable("work_item")
          .set({ version: item.version + 1 })
          .where("id", "=", item.id)
          .execute();
        await this.context.resolveInbox(
          trx,
          row.project_id,
          "assignment",
          previous.id,
        );
        await this.context.record(
          trx,
          row.project_id,
          "assignment.created",
          newAssignmentId,
          {
            assignmentId: newAssignmentId,
            workItemId: row.work_item_id,
            handoffId: id,
          },
        );
      }
      const updated = await trx
        .updateTable("handoff")
        .set({
          status: action,
          new_assignment_id: newAssignmentId,
          resolved_at: new Date(),
          version: row.version + 1,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.context.resolveInbox(trx, row.project_id, "handoff", id);
      await this.context.record(trx, row.project_id, `handoff.${action}`, id, {
        handoffId: id,
        assignmentId: row.from_assignment_id,
        newAssignmentId,
      });
      return view(updated);
    });
  }
}
