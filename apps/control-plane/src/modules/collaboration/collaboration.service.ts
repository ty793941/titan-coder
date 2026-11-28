import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  DomainError,
  assignmentCreateRequestSchema,
  collaborationMemberRequestSchema,
  collaborationVersionRequestSchema,
} from "@titan/contracts";
import {
  CollaborationContext,
  activeAssignments,
  checkVersion,
  view,
} from "./collaboration-context.js";

@Injectable()
export class CollaborationService {
  constructor(
    @Inject(CollaborationContext)
    private readonly context: CollaborationContext,
  ) {}

  async createWorkItem(taskId: string) {
    return this.context.database.db.transaction().execute(async (trx) => {
      const task = await trx
        .selectFrom("task")
        .select(["id", "project_id"])
        .where("id", "=", taskId)
        .executeTakeFirst();
      if (!task) throw new DomainError("COLLABORATION_NOT_FOUND", "任务不存在");
      await this.context.project(trx, task.project_id);
      const existing = await trx
        .selectFrom("work_item")
        .selectAll()
        .where("task_id", "=", taskId)
        .executeTakeFirst();
      if (existing) return view(existing);
      const item = await trx
        .insertInto("work_item")
        .values({
          id: `work_${randomUUID()}`,
          project_id: task.project_id,
          task_id: taskId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.context.record(
        trx,
        item.project_id,
        "work_item.created",
        item.id,
        { workItemId: item.id, taskId },
        taskId,
      );
      return view(item);
    });
  }

  async addMember(projectId: string, input: unknown) {
    const parsed = collaborationMemberRequestSchema.parse(input);
    return this.context.database.db.transaction().execute(async (trx) => {
      await this.context.project(trx, projectId);
      const existing = await trx
        .selectFrom("project_member")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("subject_type", "=", parsed.subjectType)
        .where("subject_id", "=", parsed.subjectId)
        .executeTakeFirst();
      if (existing) {
        if (parsed.expectedVersion === undefined) {
          if (existing.role === parsed.role && existing.status === "active")
            return view(existing);
          throw new DomainError(
            "COLLABORATION_VERSION_CONFLICT",
            "更新成员需要expectedVersion",
          );
        }
        checkVersion(existing.version, parsed.expectedVersion);
        const updated = await trx
          .updateTable("project_member")
          .set({ role: parsed.role, version: existing.version + 1 })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.context.record(
          trx,
          projectId,
          "project.member.updated",
          updated.id,
          { memberId: updated.id, version: updated.version },
        );
        return view(updated);
      }
      if (parsed.expectedVersion !== undefined)
        throw new DomainError("COLLABORATION_VERSION_CONFLICT", "成员尚不存在");
      const member = await trx
        .insertInto("project_member")
        .values({
          id: `member_${randomUUID()}`,
          project_id: projectId,
          subject_type: parsed.subjectType,
          subject_id: parsed.subjectId,
          role: parsed.role,
          status: "active",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.context.record(
        trx,
        projectId,
        "project.member.added",
        member.id,
        {
          memberId: member.id,
          subjectType: member.subject_type,
          subjectId: member.subject_id,
          role: member.role,
        },
      );
      return view(member);
    });
  }

  async listMembers(projectId: string) {
    return (
      await this.context.database.db
        .selectFrom("project_member")
        .selectAll()
        .where("project_id", "=", projectId)
        .orderBy("created_at")
        .orderBy("id")
        .limit(100)
        .execute()
    ).map(view);
  }

  async getWorkItem(id: string) {
    const row = await this.context.database.db
      .selectFrom("work_item")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw new DomainError("COLLABORATION_NOT_FOUND", "工作项不存在");
    return { ...view(row), assignments: await this.listAssignments(id) };
  }

  async createAssignment(
    workItemId: string,
    input: unknown,
    headerKey?: string,
  ) {
    const parsed = assignmentCreateRequestSchema.parse(input);
    const key = headerKey ?? parsed.idempotencyKey;
    if (!key || key.length > 200 || !key.trim())
      throw new DomainError("VALIDATION_FAILED", "需要Idempotency-Key");
    return this.context.database.db.transaction().execute(async (trx) => {
      const item = await trx
        .selectFrom("work_item")
        .selectAll()
        .where("id", "=", workItemId)
        .executeTakeFirst();
      if (!item)
        throw new DomainError("COLLABORATION_NOT_FOUND", "工作项不存在");
      await this.context.project(trx, item.project_id);
      const scope = `work-item:${workItemId}:assignment`;
      const replay = await this.context.idempotency.read<
        Record<string, unknown>
      >(trx, scope, key, parsed);
      if (replay) return replay;
      await this.context.member(
        trx,
        item.project_id,
        parsed.subjectType,
        parsed.subjectId,
      );
      for (const reviewer of parsed.reviewers)
        await this.context.member(trx, item.project_id, "human", reviewer);
      if (["human-owner", "agent-owner"].includes(parsed.responsibility)) {
        const duplicate = await trx
          .selectFrom("assignment")
          .select("id")
          .where("work_item_id", "=", workItemId)
          .where("responsibility", "=", parsed.responsibility)
          .where("status", "in", activeAssignments)
          .executeTakeFirst();
        if (duplicate)
          throw new DomainError(
            "COLLABORATION_DUPLICATE",
            "工作项已有当前责任人",
          );
      }
      const row = await trx
        .insertInto("assignment")
        .values({
          id: `assignment_${randomUUID()}`,
          project_id: item.project_id,
          work_item_id: workItemId,
          subject_type: parsed.subjectType,
          subject_id: parsed.subjectId,
          responsibility: parsed.responsibility,
          status: "pending",
          reviewers: JSON.stringify(parsed.reviewers),
          due_at: parsed.dueAt ? new Date(parsed.dueAt) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.context.inbox(
        trx,
        item.project_id,
        row.subject_type,
        row.subject_id,
        "assignment",
        row.id,
      );
      await this.context.record(
        trx,
        item.project_id,
        "assignment.created",
        row.id,
        {
          assignmentId: row.id,
          workItemId,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          responsibility: row.responsibility,
        },
        item.task_id,
      );
      const result = view(row);
      await this.context.idempotency.write(
        trx,
        scope,
        key,
        parsed,
        result,
        201,
      );
      return result;
    });
  }

  async listAssignments(id: string) {
    return (
      await this.context.database.db
        .selectFrom("assignment")
        .selectAll()
        .where("work_item_id", "=", id)
        .orderBy("created_at")
        .orderBy("id")
        .limit(100)
        .execute()
    ).map(view);
  }

  async changeAssignment(
    id: string,
    action: "accept" | "decline" | "complete",
    input: unknown,
  ) {
    const parsed = collaborationVersionRequestSchema.parse(input);
    return this.context.database.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("assignment")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) throw new DomainError("COLLABORATION_NOT_FOUND", "分配不存在");
      await this.context.project(trx, row.project_id);
      const current = await trx
        .selectFrom("assignment")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      await this.context.myAction(
        trx,
        current.project_id,
        current.subject_type,
        current.subject_id,
      );
      const next = {
        accept: "accepted",
        decline: "declined",
        complete: "completed",
      }[action];
      if (
        current.status === next &&
        current.version === parsed.expectedVersion + 1
      )
        return view(current);
      checkVersion(current.version, parsed.expectedVersion);
      if (
        !(
          action === "complete" ? ["accepted", "active"] : ["pending"]
        ).includes(current.status)
      )
        throw new DomainError(
          "COLLABORATION_INVALID_STATE",
          "当前状态不能执行此操作",
        );
      if (
        await trx
          .selectFrom("handoff")
          .select("id")
          .where("from_assignment_id", "=", id)
          .where("status", "=", "pending_acceptance")
          .executeTakeFirst()
      )
        throw new DomainError(
          "COLLABORATION_HANDOFF_CONFLICT",
          "待处理交接必须先完成",
        );
      const updated = await trx
        .updateTable("assignment")
        .set({ status: next, version: current.version + 1 })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.context.resolveInbox(trx, row.project_id, "assignment", id);
      await this.context.record(trx, row.project_id, `assignment.${next}`, id, {
        assignmentId: id,
        version: updated.version,
      });
      return view(updated);
    });
  }
}
