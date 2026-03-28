import { validateParts } from '../types.js';
import type { ThreadStatus, CloseReason, ArtifactType } from '../types.js';
import { buildReplyContext } from '../routes.js';
import type { WsClient, WsHub } from './protocol.js';
import {
  contentFromParts,
  wsEnrichThreadMessage,
  wsParseMentions,
  wsResolveBot,
  WS_FIELD_LIMITS,
  MAX_THREAD_TAGS,
  THREAD_STATUSES,
  CLOSE_REASONS,
  ARTIFACT_TYPES,
  ARTIFACT_KEY_PATTERN,
} from './protocol.js';

// ─── type: 'send' (channel message) ─────────────────────────

export async function handleSend(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'message')) {
    hub.sendError(client, 'Insufficient token scope: message scope required to send messages', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  if (!await hub.db.isChannelMember(data.channel_id, client.botId!)) {
    hub.sendError(client, 'Not a member of this channel', { ref });
    return;
  }

  const rateCheck = await hub.db.checkAndRecordRateLimit(client.orgId, client.botId!, 'message');
  if (!rateCheck.allowed) {
    hub.sendError(client, `Rate limit exceeded. Retry after ${rateCheck.retryAfter}s`, { ref, code: 'RATE_LIMITED', retry_after: rateCheck.retryAfter });
    return;
  }

  let partsJson: string | null = null;
  if (data.parts && Array.isArray(data.parts)) {
    const partsError = validateParts(data.parts);
    if (partsError) {
      hub.sendError(client, partsError, { ref });
      return;
    }
    partsJson = JSON.stringify(data.parts);
  }

  let content = data.content;
  if (!content && data.parts && Array.isArray(data.parts)) {
    content = contentFromParts(data.parts);
  }

  if (!content) {
    hub.sendError(client, 'content or parts is required', { ref });
    return;
  }

  if (content.length > hub.config.max_message_length) {
    hub.sendError(client, `Message too long (max ${hub.config.max_message_length} chars)`, { ref });
    return;
  }

  const contentType = data.content_type || 'text';
  const msg = await hub.db.createMessage(data.channel_id, client.botId!, content, contentType, partsJson);
  const bot = await hub.db.getBotById(client.botId!);

  await hub.db.recordAudit(client.orgId, client.botId!, 'message.send', 'channel_message', msg.id, { channel_id: data.channel_id, via: 'ws' });

  const channel = await hub.db.getChannel(data.channel_id);
  if (channel) {
    const members = await hub.db.getChannelMembers(data.channel_id);
    for (const m of members) {
      if (m.bot_id === client.botId) continue;
      await hub.db.recordCatchupEvent(channel.org_id, m.bot_id, 'channel_message_summary', {
        channel_id: channel.id,
        channel_name: channel.name ?? undefined,
        count: 1,
        last_at: msg.created_at,
      }, channel.id);
    }
  }

  await hub.broadcastMessage(data.channel_id, msg, bot?.name || 'unknown');

  if (ref) hub.sendAck(client, ref, { operation: 'send', resource_id: msg.id, channel_id: data.channel_id, message_id: msg.id, timestamp: msg.created_at });
}

// ─── type: 'send_dm' ────────────────────────────────────────

export async function handleSendDm(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'message')) {
    hub.sendError(client, 'Insufficient token scope: message scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const rateCheck = await hub.db.checkAndRecordRateLimit(client.orgId, client.botId!, 'message');
  if (!rateCheck.allowed) {
    hub.sendError(client, `Rate limit exceeded. Retry after ${rateCheck.retryAfter}s`, { ref, code: 'RATE_LIMITED', retry_after: rateCheck.retryAfter });
    return;
  }

  const { to, content_type, parts } = data;

  if (!to || typeof to !== 'string') {
    hub.sendError(client, 'to is required', { ref });
    return;
  }

  if (content_type !== undefined && typeof content_type === 'string' && Buffer.byteLength(content_type, 'utf8') > WS_FIELD_LIMITS.content_type) {
    hub.sendError(client, `content_type exceeds size limit (${WS_FIELD_LIMITS.content_type} bytes)`, { ref });
    return;
  }

  let partsJson: string | null = null;
  if (parts !== undefined) {
    const partsError = validateParts(parts);
    if (partsError) {
      hub.sendError(client, partsError, { ref });
      return;
    }
    partsJson = JSON.stringify(parts);
  }

  let resolvedContent: string | undefined = data.content ?? (parts ? contentFromParts(parts) : undefined);
  // Safety: bots may send content as object — ensure string
  if (resolvedContent && typeof resolvedContent !== 'string') {
    resolvedContent = (resolvedContent as any).text ?? JSON.stringify(resolvedContent);
  }
  if (!resolvedContent) {
    hub.sendError(client, 'content or parts is required', { ref });
    return;
  }

  const target = await wsResolveBot(hub.db, client.orgId, to);
  if (!target) {
    hub.sendError(client, `Bot not found: ${to}`, { ref, code: 'NOT_FOUND' });
    return;
  }

  if (target.id === client.botId) {
    hub.sendError(client, 'Cannot send to yourself', { ref });
    return;
  }

  if (resolvedContent.length > hub.config.max_message_length) {
    hub.sendError(client, `Message too long (max ${hub.config.max_message_length} chars)`, { ref });
    return;
  }

  const channel = await hub.db.createChannel(client.orgId, [client.botId!, target.id]);

  if (channel.isNew) {
    hub.broadcastToOrg(client.orgId, {
      type: 'channel_created',
      channel: { id: channel.id, org_id: channel.org_id, type: channel.type, name: channel.name, created_at: channel.created_at },
      members: [client.botId!, target.id],
    });
  }

  const msg = await hub.db.createMessage(channel.id, client.botId!, resolvedContent, content_type || 'text', partsJson);

  await hub.db.recordAudit(client.orgId, client.botId!, 'message.send', 'channel_message', msg.id, { channel_id: channel.id, to: target.id, via: 'ws' });

  await hub.db.recordCatchupEvent(client.orgId, target.id, 'channel_message_summary', {
    channel_id: channel.id,
    channel_name: channel.name ?? undefined,
    count: 1,
    last_at: msg.created_at,
  }, channel.id);

  const senderBot = await hub.db.getBotById(client.botId!);
  await hub.broadcastMessage(channel.id, msg, senderBot?.name || 'unknown');

  if (ref) hub.sendAck(client, ref, { operation: 'send_dm', resource_id: msg.id, channel_id: channel.id, message_id: msg.id, timestamp: msg.created_at });
}

// ─── type: 'send_thread_message' ────────────────────────────

export async function handleSendThreadMessage(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'thread')) {
    hub.sendError(client, 'Insufficient token scope: thread scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const rateCheck = await hub.db.checkAndRecordRateLimit(client.orgId, client.botId!, 'message');
  if (!rateCheck.allowed) {
    hub.sendError(client, `Rate limit exceeded. Retry after ${rateCheck.retryAfter}s`, { ref, code: 'RATE_LIMITED', retry_after: rateCheck.retryAfter });
    return;
  }

  const { thread_id, content_type, parts, metadata, reply_to } = data;

  if (!thread_id || typeof thread_id !== 'string') {
    hub.sendError(client, 'thread_id is required', { ref });
    return;
  }

  const thread = await hub.db.getThread(thread_id);
  if (!thread) {
    hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
    return;
  }
  if (thread.org_id !== client.orgId) {
    hub.sendError(client, 'Thread not in your org', { ref, code: 'FORBIDDEN' });
    return;
  }
  if (thread.status === 'resolved' || thread.status === 'closed') {
    hub.sendError(client, `Thread is ${thread.status}; operation not allowed`, { ref, code: 'THREAD_CLOSED' });
    return;
  }
  if (!await hub.db.isParticipant(thread.id, client.botId!)) {
    hub.sendError(client, 'Not a participant of this thread', { ref, code: 'JOIN_REQUIRED' });
    return;
  }

  if (content_type !== undefined && typeof content_type === 'string' && Buffer.byteLength(content_type, 'utf8') > WS_FIELD_LIMITS.content_type) {
    hub.sendError(client, `content_type exceeds size limit (${WS_FIELD_LIMITS.content_type} bytes)`, { ref });
    return;
  }

  let partsJson: string | null = null;
  if (parts !== undefined) {
    const partsError = validateParts(parts);
    if (partsError) {
      hub.sendError(client, partsError, { ref });
      return;
    }
    partsJson = JSON.stringify(parts);
  }

  let resolvedContent: string | undefined = data.content ?? (parts ? contentFromParts(parts) : undefined);
  if (resolvedContent && typeof resolvedContent !== 'string') {
    resolvedContent = (resolvedContent as any).text ?? JSON.stringify(resolvedContent);
  }
  if (!resolvedContent || typeof resolvedContent !== 'string') {
    hub.sendError(client, 'content or parts is required', { ref });
    return;
  }

  if (resolvedContent.length > hub.config.max_message_length) {
    hub.sendError(client, `Message too long (max ${hub.config.max_message_length} chars)`, { ref });
    return;
  }

  let metadataJson: string | null | undefined;
  if (metadata !== undefined) {
    if (metadata === null) {
      metadataJson = null;
    } else if (typeof metadata === 'string') {
      metadataJson = metadata;
    } else {
      try {
        metadataJson = JSON.stringify(metadata);
      } catch {
        hub.sendError(client, 'metadata must be JSON-serializable', { ref });
        return;
      }
    }
    if (metadataJson && Buffer.byteLength(metadataJson, 'utf8') > WS_FIELD_LIMITS.metadata) {
      hub.sendError(client, `metadata exceeds size limit (${WS_FIELD_LIMITS.metadata} bytes)`, { ref });
      return;
    }
  }

  // Validate reply_to if provided
  if (reply_to !== undefined && reply_to !== null) {
    if (typeof reply_to !== 'string') {
      hub.sendError(client, 'reply_to must be a string (message ID)', { ref });
      return;
    }
    const parentMsg = await hub.db.getThreadMessageById(reply_to);
    if (!parentMsg || parentMsg.thread_id !== thread.id) {
      hub.sendError(client, 'reply_to message not found in this thread', { ref, code: 'NOT_FOUND' });
      return;
    }
  }

  const threadParticipants = await hub.db.getParticipants(thread.id);
  const { mentions: mentionRefs, mentionAll } = await wsParseMentions(
    resolvedContent,
    threadParticipants,
    (id) => hub.db.getBotById(id),
  );

  const message = await hub.db.createThreadMessage(
    thread.id,
    client.botId!,
    resolvedContent,
    typeof content_type === 'string' ? content_type : 'text',
    metadataJson,
    partsJson,
    mentionRefs ? JSON.stringify(mentionRefs) : null,
    mentionAll ? 1 : 0,
    reply_to || null,
  );

  const bot = await hub.db.getBotById(client.botId!);
  const replyContext = await buildReplyContext(hub.db, message);
  const enriched = { ...wsEnrichThreadMessage(message), sender_name: bot?.name || 'unknown', ...(replyContext && { reply_to_message: replyContext }) };

  await hub.db.recordAudit(thread.org_id, client.botId!, 'message.send', 'thread_message', message.id, { thread_id: thread.id, via: 'ws' });

  for (const p of threadParticipants) {
    if (p.bot_id === client.botId) continue;
    await hub.db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_message_summary', {
      thread_id: thread.id,
      topic: thread.topic,
      count: 1,
      last_at: message.created_at,
    }, thread.id);
  }

  await hub.broadcastThreadEvent(thread.org_id, thread.id, {
    type: 'thread_message',
    thread_id: thread.id,
    message: enriched,
  });

  if (ref) hub.sendAck(client, ref, { operation: 'send_thread_message', resource_id: message.id, message_id: message.id, thread_id: thread.id, timestamp: message.created_at });
}

// ─── type: 'thread_create' ──────────────────────────────────

export async function handleThreadCreate(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'thread')) {
    hub.sendError(client, 'Insufficient token scope: thread scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const rateCheck = await hub.db.checkAndRecordRateLimit(client.orgId, client.botId!, 'thread');
  if (!rateCheck.allowed) {
    hub.sendError(client, `Rate limit exceeded. Retry after ${rateCheck.retryAfter}s`, { ref, code: 'RATE_LIMITED', retry_after: rateCheck.retryAfter });
    return;
  }

  const { topic, tags, participants, channel_id, context } = data;

  if (!topic || typeof topic !== 'string') {
    hub.sendError(client, 'topic is required', { ref });
    return;
  }

  let resolvedTags: string[] | null = null;
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags) || !tags.every((t: unknown) => typeof t === 'string')) {
      hub.sendError(client, 'tags must be an array of strings', { ref });
      return;
    }
    if (tags.length > MAX_THREAD_TAGS) {
      hub.sendError(client, `tags must have at most ${MAX_THREAD_TAGS} items`, { ref });
      return;
    }
    resolvedTags = tags.map((t: string) => t.trim()).filter((t: string) => t.length > 0);
  }

  if (participants !== undefined && !Array.isArray(participants)) {
    hub.sendError(client, 'participants must be an array', { ref });
    return;
  }

  const resolvedParticipantIds: string[] = [];
  for (const p of (participants || [])) {
    const bot = await wsResolveBot(hub.db, client.orgId, p);
    if (!bot) {
      hub.sendError(client, `Bot not found: ${p}`, { ref });
      return;
    }
    resolvedParticipantIds.push(bot.id);
  }

  let resolvedChannelId: string | undefined;
  if (channel_id !== undefined && channel_id !== null) {
    if (typeof channel_id !== 'string') {
      hub.sendError(client, 'channel_id must be a string', { ref });
      return;
    }
    const channel = await hub.db.getChannel(channel_id);
    if (!channel || channel.org_id !== client.orgId) {
      hub.sendError(client, 'Invalid channel_id', { ref });
      return;
    }
    resolvedChannelId = channel.id;
  }

  let contextJson: string | null | undefined;
  if (context !== undefined) {
    if (context === null) {
      contextJson = null;
    } else if (typeof context === 'string') {
      contextJson = context;
    } else {
      try {
        contextJson = JSON.stringify(context);
      } catch {
        hub.sendError(client, 'context must be JSON-serializable', { ref });
        return;
      }
    }
  }

  try {
    const thread = await hub.db.createThread(
      client.orgId,
      client.botId!,
      topic,
      resolvedTags,
      resolvedParticipantIds,
      resolvedChannelId,
      contextJson,
      null, // permission_policy — use HTTP API for advanced policy config
    );

    await hub.db.recordAudit(client.orgId, client.botId!, 'thread.create', 'thread', thread.id, { topic, tags: resolvedTags, via: 'ws' });

    const allParticipantIds = Array.from(new Set([client.botId!, ...resolvedParticipantIds]));
    for (const pid of allParticipantIds) {
      if (pid === client.botId) continue;
      await hub.db.recordCatchupEvent(client.orgId, pid, 'thread_invited', {
        thread_id: thread.id,
        topic: thread.topic,
        inviter: client.botId!,
      });
    }

    await hub.broadcastThreadEvent(client.orgId, thread.id, {
      type: 'thread_created',
      thread,
    });

    for (const pid of allParticipantIds) {
      const bot = await hub.db.getBotById(pid);
      if (!bot) continue;
      await hub.broadcastThreadEvent(client.orgId, thread.id, {
        type: 'thread_participant',
        thread_id: thread.id,
        bot_id: pid,
        bot_name: bot.name,
        action: 'joined',
        by: client.botId!,
      });
    }

    if (ref) hub.sendAck(client, ref, { operation: 'thread_create', resource_id: thread.id, thread_id: thread.id, topic: thread.topic, revision: thread.revision, timestamp: thread.created_at });
  } catch (error: any) {
    hub.sendError(client, error.message || 'Failed to create thread', { ref });
  }
}

// ─── type: 'thread_update' ──────────────────────────────────

export async function handleThreadUpdate(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'thread')) {
    hub.sendError(client, 'Insufficient token scope: thread scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const { thread_id, status: statusInput, close_reason, topic, context, expected_revision } = data;

  if (!thread_id || typeof thread_id !== 'string') {
    hub.sendError(client, 'thread_id is required', { ref });
    return;
  }

  // Validate expected_revision if provided
  if (expected_revision !== undefined && (typeof expected_revision !== 'number' || !Number.isInteger(expected_revision) || expected_revision < 1)) {
    hub.sendError(client, 'expected_revision must be a positive integer', { ref });
    return;
  }

  const thread = await hub.db.getThread(thread_id);
  if (!thread) {
    hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
    return;
  }
  if (thread.org_id !== client.orgId) {
    hub.sendError(client, 'Thread not in your org', { ref, code: 'FORBIDDEN' });
    return;
  }
  if (!await hub.db.isParticipant(thread.id, client.botId!)) {
    hub.sendError(client, 'Not a participant of this thread', { ref, code: 'JOIN_REQUIRED' });
    return;
  }

  if (statusInput === undefined && context === undefined && close_reason === undefined && topic === undefined) {
    hub.sendError(client, 'No updatable fields provided', { ref });
    return;
  }

  // Block non-status mutations on terminal threads (status change = reopen is allowed)
  if ((thread.status === 'resolved' || thread.status === 'closed') && statusInput === undefined) {
    hub.sendError(client, 'Thread is in terminal state; no updates allowed', { ref, code: 'THREAD_CLOSED' });
    return;
  }

  if (topic !== undefined && (typeof topic !== 'string' || topic.trim().length === 0)) {
    hub.sendError(client, 'topic must be a non-empty string', { ref });
    return;
  }

  let status: ThreadStatus | undefined;
  if (statusInput !== undefined) {
    if (typeof statusInput !== 'string' || !THREAD_STATUSES.has(statusInput as ThreadStatus)) {
      hub.sendError(client, 'Invalid status', { ref });
      return;
    }
    status = statusInput as ThreadStatus;
  }

  let closeReason: CloseReason | undefined;
  if (close_reason !== undefined) {
    if (typeof close_reason !== 'string' || !CLOSE_REASONS.has(close_reason as CloseReason)) {
      hub.sendError(client, 'Invalid close_reason', { ref });
      return;
    }
    closeReason = close_reason as CloseReason;
  }

  if (status === 'closed' && closeReason === undefined) {
    hub.sendError(client, 'close_reason is required for closed status', { ref });
    return;
  }
  if (status !== 'closed' && closeReason !== undefined) {
    hub.sendError(client, 'close_reason is only allowed with closed status', { ref });
    return;
  }

  let contextJson: string | null | undefined;
  if (context !== undefined) {
    if (context === null) {
      contextJson = null;
    } else if (typeof context === 'string') {
      contextJson = context;
    } else {
      try {
        contextJson = JSON.stringify(context);
      } catch {
        hub.sendError(client, 'context must be JSON-serializable', { ref });
        return;
      }
    }
  }

  // Permission policy check for status changes
  if (status !== undefined) {
    const policyAction = status === 'resolved' ? 'resolve' as const
      : status === 'closed' ? 'close' as const
      : null;
    if (policyAction && !await hub.db.checkThreadPermission(thread, client.botId!, policyAction)) {
      await hub.db.recordAudit(thread.org_id, client.botId!, 'thread.permission_denied', 'thread', thread.id, {
        action: policyAction,
        status,
        via: 'ws',
      });
      hub.sendError(client, `Permission denied: your label does not allow '${policyAction}' on this thread`, { ref, code: 'FORBIDDEN' });
      return;
    }
  }

  const changes: string[] = [];
  let updated = thread;
  // Revision check applies only to the first DB update; subsequent updates in the same
  // request are trusted (the first write proves we held the correct revision).
  let revCheck = expected_revision;

  try {
    if (status !== undefined) {
      const previousStatus = thread.status;
      const result = await hub.db.updateThreadStatus(thread.id, status, closeReason, revCheck);
      revCheck = undefined; // consumed
      if (!result) {
        hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
        return;
      }
      updated = result;
      changes.push('status');
      if (status === 'closed') changes.push('close_reason');
      if (status === 'resolved') changes.push('resolved_at');

      await hub.db.recordAudit(thread.org_id, client.botId!, 'thread.status_changed', 'thread', thread.id, {
        from: previousStatus,
        to: status,
        close_reason: closeReason ?? null,
        via: 'ws',
      });

      const participants = await hub.db.getParticipants(thread.id);
      for (const p of participants) {
        await hub.db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_status_changed', {
          thread_id: thread.id,
          topic: thread.topic,
          from: previousStatus,
          to: status,
          by: client.botId!,
        });
      }
    }

    if (context !== undefined) {
      const result = await hub.db.updateThreadContext(thread.id, contextJson ?? null, revCheck);
      revCheck = undefined; // consumed
      if (!result) {
        hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
        return;
      }
      updated = result;
      changes.push('context');
    }

    if (topic !== undefined) {
      const result = await hub.db.updateThreadTopic(thread.id, topic.trim(), revCheck);
      revCheck = undefined; // consumed
      if (!result) {
        hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
        return;
      }
      updated = result;
      changes.push('topic');
    }
  } catch (error: any) {
    if (error.message === 'REVISION_CONFLICT') {
      hub.sendError(client, 'Revision conflict: the thread was modified since your last read. Re-fetch and retry.', { ref, code: 'REVISION_CONFLICT' });
      return;
    }
    hub.sendError(client, error.message || 'Failed to update thread', { ref });
    return;
  }

  await hub.broadcastThreadEvent(thread.org_id, thread.id, {
    type: 'thread_updated',
    thread: updated,
    changes,
  });

  if (ref) hub.sendAck(client, ref, { operation: 'thread_update', resource_id: thread.id, thread_id: thread.id, changes, revision: updated.revision, timestamp: updated.updated_at });
}

// ─── type: 'thread_invite' ──────────────────────────────────

export async function handleThreadInvite(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'thread')) {
    hub.sendError(client, 'Insufficient token scope: thread scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const { thread_id, bot_id, label } = data;

  if (!thread_id || typeof thread_id !== 'string') {
    hub.sendError(client, 'thread_id is required', { ref });
    return;
  }
  if (!bot_id || typeof bot_id !== 'string') {
    hub.sendError(client, 'bot_id is required', { ref });
    return;
  }
  if (label !== undefined && label !== null && typeof label !== 'string') {
    hub.sendError(client, 'label must be a string', { ref });
    return;
  }

  const thread = await hub.db.getThread(thread_id);
  if (!thread) {
    hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
    return;
  }
  if (thread.org_id !== client.orgId) {
    hub.sendError(client, 'Thread not in your org', { ref, code: 'FORBIDDEN' });
    return;
  }
  if (thread.status === 'resolved' || thread.status === 'closed') {
    hub.sendError(client, `Thread is ${thread.status}; operation not allowed`, { ref, code: 'THREAD_CLOSED' });
    return;
  }
  if (!await hub.db.isParticipant(thread.id, client.botId!)) {
    hub.sendError(client, 'Not a participant of this thread', { ref, code: 'JOIN_REQUIRED' });
    return;
  }

  // Permission policy check for invite
  if (!await hub.db.checkThreadPermission(thread, client.botId!, 'invite')) {
    hub.sendError(client, 'Permission denied: your label does not allow inviting participants', { ref, code: 'FORBIDDEN' });
    return;
  }

  const bot = await wsResolveBot(hub.db, thread.org_id, bot_id);
  if (!bot) {
    hub.sendError(client, `Bot not found: ${bot_id}`, { ref, code: 'NOT_FOUND' });
    return;
  }

  const alreadyParticipant = await hub.db.isParticipant(thread.id, bot.id);
  if (alreadyParticipant && label !== undefined) {
    hub.sendError(client, 'Participant already exists; cannot change label via invite', { ref });
    return;
  }

  try {
    const participant = await hub.db.addParticipant(thread.id, bot.id, label);

    if (!alreadyParticipant) {
      await hub.db.recordAudit(thread.org_id, client.botId!, 'thread.invite', 'thread', thread.id, {
        invited_bot_id: bot.id,
        invited_bot_name: bot.name,
        via: 'ws',
      });

      await hub.db.recordCatchupEvent(thread.org_id, bot.id, 'thread_invited', {
        thread_id: thread.id,
        topic: thread.topic,
        inviter: client.botId!,
      });

      await hub.broadcastThreadEvent(thread.org_id, thread.id, {
        type: 'thread_participant',
        thread_id: thread.id,
        bot_id: bot.id,
        bot_name: bot.name,
        action: 'joined',
        by: client.botId!,
        label: participant.label,
      });
    }

    if (ref) hub.sendAck(client, ref, { operation: 'thread_invite', resource_id: thread.id, thread_id: thread.id, bot_id: bot.id, already_joined: alreadyParticipant, timestamp: Date.now() });
  } catch (error: any) {
    hub.sendError(client, error.message || 'Failed to add participant', { ref });
  }
}

// ─── type: 'thread_join' ────────────────────────────────────

export async function handleThreadJoin(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'thread')) {
    hub.sendError(client, 'Insufficient token scope: thread scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const { thread_id } = data;

  if (!thread_id || typeof thread_id !== 'string') {
    hub.sendError(client, 'thread_id is required', { ref });
    return;
  }

  const thread = await hub.db.getThread(thread_id);
  if (!thread) {
    hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
    return;
  }
  if (thread.org_id !== client.orgId) {
    hub.sendError(client, 'Thread not in your org', { ref, code: 'FORBIDDEN' });
    return;
  }
  if (thread.status === 'resolved' || thread.status === 'closed') {
    hub.sendError(client, `Thread is ${thread.status}; cannot join`, { ref, code: 'THREAD_CLOSED' });
    return;
  }

  // Already a participant — idempotent success
  if (await hub.db.isParticipant(thread.id, client.botId!)) {
    if (ref) hub.sendAck(client, ref, { operation: 'thread_join', resource_id: thread.id, thread_id: thread.id, status: 'already_joined', timestamp: Date.now() });
    return;
  }

  try {
    const participant = await hub.db.addParticipant(thread.id, client.botId!);

    const bot = await hub.db.getBotById(client.botId!);
    await hub.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_participant',
      thread_id: thread.id,
      bot_id: client.botId!,
      bot_name: bot?.name || 'unknown',
      action: 'joined',
      by: client.botId!,
    });

    await hub.db.recordAudit(thread.org_id, client.botId!, 'thread.join', 'thread', thread.id, { via: 'ws' });

    if (ref) hub.sendAck(client, ref, { operation: 'thread_join', resource_id: thread.id, thread_id: thread.id, status: 'joined', joined_at: participant.joined_at, timestamp: participant.joined_at });
  } catch (error: any) {
    hub.sendError(client, error.message || 'Failed to join thread', { ref });
  }
}

// ─── type: 'thread_leave' ───────────────────────────────────

export async function handleThreadLeave(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'thread')) {
    hub.sendError(client, 'Insufficient token scope: thread scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const { thread_id } = data;

  if (!thread_id || typeof thread_id !== 'string') {
    hub.sendError(client, 'thread_id is required', { ref });
    return;
  }

  const thread = await hub.db.getThread(thread_id);
  if (!thread) {
    hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
    return;
  }
  if (thread.org_id !== client.orgId) {
    hub.sendError(client, 'Thread not in your org', { ref, code: 'FORBIDDEN' });
    return;
  }
  if (thread.status === 'resolved' || thread.status === 'closed') {
    hub.sendError(client, `Thread is ${thread.status}; operation not allowed`, { ref, code: 'THREAD_CLOSED' });
    return;
  }
  if (!await hub.db.isParticipant(thread.id, client.botId!)) {
    hub.sendError(client, 'Not a participant of this thread', { ref, code: 'JOIN_REQUIRED' });
    return;
  }

  // Cannot leave if you're the last participant
  const participants = await hub.db.getParticipants(thread.id);
  if (participants.length <= 1) {
    hub.sendError(client, 'Cannot leave: you are the last participant', { ref });
    return;
  }

  try {
    // Broadcast BEFORE removing so the leaving bot is still in the recipient list
    const bot = await hub.db.getBotById(client.botId!);
    await hub.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_participant',
      thread_id: thread.id,
      bot_id: client.botId!,
      bot_name: bot?.name || 'unknown',
      action: 'left',
      by: client.botId!,
    });

    // Record catchup so the bot sees it even if offline
    await hub.db.recordCatchupEvent(thread.org_id, client.botId!, 'thread_participant_removed', {
      thread_id: thread.id,
      topic: thread.topic,
      removed_by: client.botId!,
    });

    await hub.db.removeParticipant(thread.id, client.botId!);

    await hub.db.recordAudit(thread.org_id, client.botId!, 'thread.leave', 'thread', thread.id, { via: 'ws' });

    if (ref) hub.sendAck(client, ref, { operation: 'thread_leave', resource_id: thread.id, thread_id: thread.id, timestamp: Date.now() });
  } catch (error: any) {
    hub.sendError(client, error.message || 'Failed to leave thread', { ref });
  }
}

// ─── type: 'thread_remove_participant' ──────────────────────

export async function handleThreadRemoveParticipant(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'thread')) {
    hub.sendError(client, 'Insufficient token scope: thread scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const { thread_id, bot_id } = data;

  if (!thread_id || typeof thread_id !== 'string') {
    hub.sendError(client, 'thread_id is required', { ref });
    return;
  }
  if (!bot_id || typeof bot_id !== 'string') {
    hub.sendError(client, 'bot_id is required', { ref });
    return;
  }

  const thread = await hub.db.getThread(thread_id);
  if (!thread) {
    hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
    return;
  }
  if (thread.org_id !== client.orgId) {
    hub.sendError(client, 'Thread not in your org', { ref, code: 'FORBIDDEN' });
    return;
  }
  if (thread.status === 'resolved' || thread.status === 'closed') {
    hub.sendError(client, `Thread is ${thread.status}; operation not allowed`, { ref, code: 'THREAD_CLOSED' });
    return;
  }
  if (!await hub.db.isParticipant(thread.id, client.botId!)) {
    hub.sendError(client, 'Not a participant of this thread', { ref, code: 'JOIN_REQUIRED' });
    return;
  }

  const target = await wsResolveBot(hub.db, thread.org_id, bot_id);
  if (!target) {
    hub.sendError(client, `Bot not found: ${bot_id}`, { ref, code: 'NOT_FOUND' });
    return;
  }

  if (!await hub.db.isParticipant(thread.id, target.id)) {
    hub.sendError(client, 'Target bot is not a participant', { ref, code: 'NOT_FOUND' });
    return;
  }

  // Self-removal is always allowed; removing others requires 'remove' permission
  if (target.id !== client.botId) {
    if (!await hub.db.checkThreadPermission(thread, client.botId!, 'remove')) {
      hub.sendError(client, 'Permission denied: your label does not allow removing participants', { ref, code: 'FORBIDDEN' });
      return;
    }
  }

  // Cannot remove the last participant
  const participants = await hub.db.getParticipants(thread.id);
  if (participants.length <= 1) {
    hub.sendError(client, 'Cannot remove the last participant', { ref });
    return;
  }

  try {
    // Broadcast BEFORE removing so the target bot is still in the recipient list
    await hub.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_participant',
      thread_id: thread.id,
      bot_id: target.id,
      bot_name: target.name,
      action: 'left',
      by: client.botId!,
    });

    // Record catchup so the removed bot sees it even if offline
    await hub.db.recordCatchupEvent(thread.org_id, target.id, 'thread_participant_removed', {
      thread_id: thread.id,
      topic: thread.topic,
      removed_by: client.botId!,
    });

    await hub.db.removeParticipant(thread.id, target.id);

    await hub.db.recordAudit(thread.org_id, client.botId!, 'thread.remove_participant', 'thread', thread.id, {
      removed_bot_id: target.id,
      removed_bot_name: target.name,
      via: 'ws',
    });

    if (ref) hub.sendAck(client, ref, { operation: 'thread_remove_participant', resource_id: thread.id, thread_id: thread.id, bot_id: target.id, timestamp: Date.now() });
  } catch (error: any) {
    hub.sendError(client, error.message || 'Failed to remove participant', { ref });
  }
}

// ─── type: 'artifact_add' ───────────────────────────────────

export async function handleArtifactAdd(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'thread')) {
    hub.sendError(client, 'Insufficient token scope: thread scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const { thread_id, artifact_key, artifact_type: artifactType, title, content, language, url, mime_type } = data;

  if (!thread_id || typeof thread_id !== 'string') {
    hub.sendError(client, 'thread_id is required', { ref });
    return;
  }

  if (!artifact_key || typeof artifact_key !== 'string' || !ARTIFACT_KEY_PATTERN.test(artifact_key)) {
    hub.sendError(client, 'artifact_key is required and must match [A-Za-z0-9._~-]+', { ref });
    return;
  }

  const resolvedType: ArtifactType = (artifactType && ARTIFACT_TYPES.has(artifactType)) ? artifactType : 'text';
  if (artifactType !== undefined && !ARTIFACT_TYPES.has(artifactType)) {
    hub.sendError(client, `Invalid artifact type: ${artifactType}`, { ref });
    return;
  }

  const thread = await hub.db.getThread(thread_id);
  if (!thread) {
    hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
    return;
  }
  if (thread.org_id !== client.orgId) {
    hub.sendError(client, 'Thread not in your org', { ref, code: 'FORBIDDEN' });
    return;
  }
  if (thread.status === 'resolved' || thread.status === 'closed') {
    hub.sendError(client, `Thread is ${thread.status}; operation not allowed`, { ref, code: 'THREAD_CLOSED' });
    return;
  }
  if (!await hub.db.isParticipant(thread.id, client.botId!)) {
    hub.sendError(client, 'Not a participant of this thread', { ref, code: 'JOIN_REQUIRED' });
    return;
  }

  // Check uniqueness
  const existing = await hub.db.getArtifact(thread.id, artifact_key);
  if (existing) {
    hub.sendError(client, `Artifact key already exists: ${artifact_key}`, { ref, code: 'CONFLICT' });
    return;
  }

  try {
    const artifact = await hub.db.addArtifact(
      thread.id,
      client.botId!,
      artifact_key,
      resolvedType,
      title ?? null,
      content ?? null,
      language ?? null,
      url ?? null,
      mime_type ?? null,
    );

    await hub.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_artifact',
      thread_id: thread.id,
      artifact,
      action: 'added',
    });

    // Record catchup events for all participants except the contributor
    const participants = await hub.db.getParticipants(thread.id);
    for (const p of participants) {
      if (p.bot_id === client.botId!) continue;
      await hub.db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_artifact_added', {
        thread_id: thread.id,
        artifact_key: artifact.artifact_key,
        version: artifact.version,
      }, thread.id);
    }

    await hub.db.recordAudit(thread.org_id, client.botId!, 'artifact.add', 'artifact', artifact.id, {
      thread_id: thread.id,
      artifact_key,
      via: 'ws',
    });

    if (ref) hub.sendAck(client, ref, { operation: 'artifact_add', resource_id: artifact.id, thread_id: thread.id, artifact_key, version: artifact.version, timestamp: artifact.created_at });
  } catch (error: any) {
    hub.sendError(client, error.message || 'Failed to add artifact', { ref });
  }
}

// ─── type: 'artifact_update' ────────────────────────────────

export async function handleArtifactUpdate(hub: WsHub, client: WsClient, data: any): Promise<void> {
  const ref = data.ref;

  if (!hub.clientHasScope(client, 'thread')) {
    hub.sendError(client, 'Insufficient token scope: thread scope required', { ref, code: 'INSUFFICIENT_SCOPE' });
    return;
  }

  const { thread_id, artifact_key, content, title } = data;

  if (!thread_id || typeof thread_id !== 'string') {
    hub.sendError(client, 'thread_id is required', { ref });
    return;
  }

  if (!artifact_key || typeof artifact_key !== 'string' || !ARTIFACT_KEY_PATTERN.test(artifact_key)) {
    hub.sendError(client, 'artifact_key is required and must match [A-Za-z0-9._~-]+', { ref });
    return;
  }

  if (content === undefined || typeof content !== 'string') {
    hub.sendError(client, 'content is required and must be a string', { ref });
    return;
  }

  const thread = await hub.db.getThread(thread_id);
  if (!thread) {
    hub.sendError(client, 'Thread not found', { ref, code: 'NOT_FOUND' });
    return;
  }
  if (thread.org_id !== client.orgId) {
    hub.sendError(client, 'Thread not in your org', { ref, code: 'FORBIDDEN' });
    return;
  }
  if (thread.status === 'resolved' || thread.status === 'closed') {
    hub.sendError(client, `Thread is ${thread.status}; operation not allowed`, { ref, code: 'THREAD_CLOSED' });
    return;
  }
  if (!await hub.db.isParticipant(thread.id, client.botId!)) {
    hub.sendError(client, 'Not a participant of this thread', { ref, code: 'JOIN_REQUIRED' });
    return;
  }

  try {
    const artifact = await hub.db.updateArtifact(thread.id, artifact_key, client.botId!, content, title ?? undefined);
    if (!artifact) {
      hub.sendError(client, `Artifact not found: ${artifact_key}`, { ref, code: 'NOT_FOUND' });
      return;
    }

    await hub.broadcastThreadEvent(thread.org_id, thread.id, {
      type: 'thread_artifact',
      thread_id: thread.id,
      artifact,
      action: 'updated',
    });

    // Record catchup events for all participants except the contributor
    const participants = await hub.db.getParticipants(thread.id);
    for (const p of participants) {
      if (p.bot_id === client.botId!) continue;
      await hub.db.recordCatchupEvent(thread.org_id, p.bot_id, 'thread_artifact_added', {
        thread_id: thread.id,
        artifact_key: artifact.artifact_key,
        version: artifact.version,
      }, thread.id);
    }

    await hub.db.recordAudit(thread.org_id, client.botId!, 'artifact.update', 'artifact', artifact.id, {
      thread_id: thread.id,
      artifact_key,
      version: artifact.version,
      via: 'ws',
    });

    if (ref) hub.sendAck(client, ref, { operation: 'artifact_update', resource_id: artifact.id, thread_id: thread.id, artifact_key, version: artifact.version, timestamp: artifact.updated_at });
  } catch (error: any) {
    hub.sendError(client, error.message || 'Failed to update artifact', { ref });
  }
}
