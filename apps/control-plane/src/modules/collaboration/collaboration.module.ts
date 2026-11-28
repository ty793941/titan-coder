import { Module } from "@nestjs/common";
import { IdempotencyService } from "../../common/idempotency.service.js";
import { EventsService } from "../events/events.service.js";
import { CollaborationController } from "./collaboration.controller.js";
import { CollaborationService } from "./collaboration.service.js";
import { CollaborationContext } from "./collaboration-context.js";
import { CollaborationReviewsService } from "./collaboration-reviews.service.js";
import { CollaborationHandoffsService } from "./collaboration-handoffs.service.js";
import { CollaborationInboxService } from "./collaboration-inbox.service.js";
import { CollaborationConsoleGuard } from "./collaboration-auth.js";

@Module({
  controllers: [CollaborationController],
  providers: [
    CollaborationContext,
    CollaborationService,
    CollaborationReviewsService,
    CollaborationHandoffsService,
    CollaborationInboxService,
    CollaborationConsoleGuard,
    IdempotencyService,
    EventsService,
  ],
})
export class CollaborationModule {}
