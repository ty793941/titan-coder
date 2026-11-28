import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { collaborationEmptyRequestSchema } from '@titan/contracts';
import { CollaborationService } from './collaboration.service.js';
import { CollaborationReviewsService } from './collaboration-reviews.service.js';
import { CollaborationHandoffsService } from './collaboration-handoffs.service.js';
import { CollaborationInboxService } from './collaboration-inbox.service.js';
import { CollaborationConsoleGuard } from './collaboration-auth.js';

@Controller('/api')
@UseGuards(CollaborationConsoleGuard)
export class CollaborationController {
  constructor(
    @Inject(CollaborationService)
    private readonly collaboration: CollaborationService,
    @Inject(CollaborationReviewsService)
    private readonly reviews: CollaborationReviewsService,
    @Inject(CollaborationHandoffsService)
    private readonly handoffs: CollaborationHandoffsService,
    @Inject(CollaborationInboxService)
    private readonly inbox: CollaborationInboxService,
  ) {}
  @Post('/tasks/:taskId/work-item') createWorkItem(
    @Param('taskId') taskId: string,
    @Body() body: unknown,
  ) {
    collaborationEmptyRequestSchema.parse(body);
    return this.collaboration.createWorkItem(taskId);
  }
  @Post('/projects/:projectId/members') addMember(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    return this.collaboration.addMember(projectId, body);
  }
  @Get('/projects/:projectId/members') listMembers(
    @Param('projectId') projectId: string,
  ) {
    return this.collaboration.listMembers(projectId);
  }
  @Get('/work-items/:workItemId') getWorkItem(@Param('workItemId') id: string) {
    return this.collaboration.getWorkItem(id);
  }
  @Post('/work-items/:workItemId/assignments') createAssignment(
    @Param('workItemId') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.collaboration.createAssignment(id, body, key);
  }
  @Get('/work-items/:workItemId/assignments') listAssignments(
    @Param('workItemId') id: string,
  ) {
    return this.collaboration.listAssignments(id);
  }
  @Post('/assignments/:id/accept') @HttpCode(200) accept(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.collaboration.changeAssignment(id, 'accept', body);
  }
  @Post('/assignments/:id/decline') @HttpCode(200) decline(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.collaboration.changeAssignment(id, 'decline', body);
  }
  @Post('/assignments/:id/complete') @HttpCode(200) complete(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.collaboration.changeAssignment(id, 'complete', body);
  }
  @Post('/review-requests') createReview(
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.reviews.create(body, key);
  }
  @Get('/projects/:projectId/review-requests') listReviews(
    @Param('projectId') id: string,
  ) {
    return this.reviews.list(id);
  }
  @Post('/review-requests/:id/approve') @HttpCode(200) approve(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.reviews.decide(id, 'approved', body);
  }
  @Post('/review-requests/:id/request-changes') @HttpCode(200) requestChanges(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.reviews.decide(id, 'changes_requested', body);
  }
  @Post('/review-requests/:id/cancel') @HttpCode(200) cancelReview(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.reviews.decide(id, 'cancelled', body);
  }
  @Post('/assignments/:id/handoffs') createHandoff(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.handoffs.create(id, body, key);
  }
  @Get('/work-items/:id/handoffs') listHandoffs(@Param('id') id: string) {
    return this.handoffs.list(id);
  }
  @Post('/handoffs/:id/accept') @HttpCode(200) acceptHandoff(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.handoffs.decide(id, 'accepted', body);
  }
  @Post('/handoffs/:id/decline') @HttpCode(200) declineHandoff(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.handoffs.decide(id, 'declined', body);
  }
  @Get('/me/inbox') listInbox(@Query() query: unknown) {
    return this.inbox.list(query);
  }
  @Post('/inbox/:id/read') @HttpCode(200) readInbox(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.inbox.change(id, 'read', body);
  }
  @Post('/inbox/:id/resolve') @HttpCode(200) resolveInbox(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.inbox.change(id, 'resolved', body);
  }
  @Post('/inbox/:id/dismiss') @HttpCode(200) dismissInbox(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.inbox.change(id, 'dismissed', body);
  }
}
