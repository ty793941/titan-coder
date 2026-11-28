import { Inject, Injectable } from "@nestjs/common";
import {
  DomainError,
  collaborationPageSchema,
  collaborationVersionRequestSchema,
} from "@titan/contracts";
import {
  CollaborationContext,
  checkVersion,
  localActor,
  view,
} from "./collaboration-context.js";

@Injectable()
export class CollaborationInboxService {
  constructor(
    @Inject(CollaborationContext)
    private readonly context: CollaborationContext,
  ) {}

  async list(input: unknown) {
    const parsed = collaborationPageSchema.parse(input);
    return this.context.database.db.transaction().execute(async (trx) => {
      await this.context.member(trx, parsed.projectId, "human", localActor.id);
      return (
        await trx
          .selectFrom("collaboration_inbox_item")
          .selectAll()
          .where("project_id", "=", parsed.projectId)
          .where("subject_type", "=", "human")
          .where("subject_id", "=", localActor.id)
          .where("status", "=", parsed.status)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(parsed.limit)
          .offset(parsed.offset)
          .execute()
      ).map((row) => ({
        ...view(row),
        title:
          {
            assignment: "新的责任分配",
            review: "待处理评审",
            handoff: "待接收交接",
            blocked: "评审需要修改",
            approval: "待审批事项",
          }[row.kind] ?? "项目协作事项",
      }));
    });
  }

  async change(
    id: string,
    action: "read" | "resolved" | "dismissed",
    input: unknown,
  ) {
    const parsed = collaborationVersionRequestSchema.parse(input);
    return this.context.database.db.transaction().execute(async (trx) => {
      const source = await trx
        .selectFrom("collaboration_inbox_item")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!source)
        throw new DomainError("COLLABORATION_NOT_FOUND", "Inbox事项不存在");
      await this.context.project(trx, source.project_id);
      const row = await trx
        .selectFrom("collaboration_inbox_item")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      await this.context.myAction(
        trx,
        row.project_id,
        row.subject_type,
        row.subject_id,
      );
      if (row.status === action && row.version === parsed.expectedVersion + 1)
        return view(row);
      checkVersion(row.version, parsed.expectedVersion);
      if (!["pending", "read"].includes(row.status))
        throw new DomainError("COLLABORATION_INVALID_STATE", "Inbox事项已结束");
      if (action === "resolved" && row.kind !== "blocked")
        throw new DomainError(
          "COLLABORATION_INVALID_STATE",
          "请通过来源对象完成事项，不能通过Inbox绕过评审或交接",
        );
      const updated = await trx
        .updateTable("collaboration_inbox_item")
        .set({
          status: action,
          version: row.version + 1,
          resolved_at: action === "read" ? null : new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.context.record(trx, row.project_id, `inbox.${action}`, id, {
        inboxId: id,
        sourceId: row.source_id,
        kind: row.kind,
        version: updated.version,
      });
      return view(updated);
    });
  }
}
