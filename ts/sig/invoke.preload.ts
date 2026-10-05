// Copyright 2026 Michael Neale
// SPDX-License-Identifier: AGPL-3.0-only

// Renderer side of the Phase 1 Sig loop (PLANS/SIG_PHASE1_INVOCATION_CONTRACT.md).
// Called from the composer's sendMultiMediaMessage thunk. The question is
// posted by the normal send path; this module only decides whether a submit is
// a Sig invocation, runs the preflight before the question goes out, and posts
// exactly one reply into the same group afterwards.

import { ipcRenderer } from 'electron';
import type { MessageAttributesType } from '../model-types.d.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';
import type { DraftBodyRanges } from '../types/BodyRange.std.ts';
import { BodyRange } from '../types/BodyRange.std.ts';
import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';
import { isGroupV2 } from '../util/whatTypeOfConversation.dom.ts';
import { isMember } from '../util/groupMembershipUtils.preload.ts';
import { makeQuote } from '../util/makeQuote.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { DataReader } from '../sql/Client.preload.ts';
import { isIncoming } from '../messages/helpers.std.ts';
import { parseSigInvocation } from './parse.std.ts';
import { SigLocalBubble } from './localBubble.preload.ts';

const log = createLogger('sig/invoke');

const ANSWER_MAX_CHARS = 6_000;

type PreflightResult =
  | { ok: true; models: ReadonlyArray<string> }
  | { ok: false; error: string };

type AskResult =
  | {
      ok: true;
      model: string;
      answer: string;
      firstChunkMs: number;
      totalMs: number;
      cancelled: boolean;
    }
  | { ok: false; error: string };

type Chunk = { askId: string; text: string };
type ToolRequest = {
  askId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
};
type ToolResult = { ok: true; content: string } | { ok: false; error: string };

const THINKING = 'sig · thinking…';
const STOP_HINT = '\n\n(type @sig stop to cancel)';
// Mirrors contract §2.1: a `stop` prompt is a local command, never a question.
const STOP_PROMPT = /^stop$/iu;

// askId -> live local bubble, for `sig:chunk` delivery.
const bubbles = new Map<string, SigLocalBubble>();
// conversationId -> askId of the in-flight invocation, for `@sig stop`.
const inflightByConversation = new Map<string, string>();
// askId -> where the question lives, so a `sig:tool` request can only ever
// read the group it was asked in (and never the question or the bubble).
const askContext = new Map<
  string,
  { conversationId: string; excludeIds: ReadonlySet<string> }
>();

ipcRenderer.on('sig:chunk', (_event, chunk: Chunk) => {
  const bubble = bubbles.get(chunk.askId);
  if (!bubble) {
    return;
  }
  const text = chunk.text.trim();
  bubble.update(
    text.length > 0 ? `${text} ▌${STOP_HINT}` : THINKING + STOP_HINT
  );
});

// GDK agent path: the main process has already obtained the requester's
// consent; this is the only code that reads Signal messages for Sig, and it
// reads only the group the question was asked in.
ipcRenderer.on('sig:tool', (_event, request: ToolRequest) => {
  void (async () => {
    let result: ToolResult;
    try {
      result = { ok: true, content: await runTool(request) };
    } catch (error) {
      result = { ok: false, error: Errors.toLogFormat(error) };
    }
    await ipcRenderer.invoke(
      'sig:tool_result',
      request.askId,
      request.callId,
      result
    );
  })();
});

const GROUP_CONTEXT_MAX = 50;
const GROUP_CONTEXT_LINE_MAX = 500;

async function runTool(request: ToolRequest): Promise<string> {
  if (request.name !== 'group_context') {
    throw new Error(`unknown tool ${request.name}`);
  }
  const context = askContext.get(request.askId);
  if (!context) {
    throw new Error('no in-flight invocation for this tool call');
  }
  const count = Math.min(
    Math.max(Math.trunc(Number(request.args.count) || 20), 1),
    GROUP_CONTEXT_MAX
  );
  bubbles
    .get(request.askId)
    ?.update(`sig · reading the last ${count} messages…${STOP_HINT}`);
  const lines = await readGroupContext(context, count);
  log.info(
    `group_context: askId=${request.askId} requested=${count} returned=${lines.length}`
  );
  return lines.length > 0
    ? lines.join('\n')
    : '(no earlier text messages in this group)';
}

// Oldest first, text bodies only, excluding the question itself and Sig's own
// local bubble. Names are the requester's local display names for the
// members — the same thing they see on screen.
async function readGroupContext(
  context: { conversationId: string; excludeIds: ReadonlySet<string> },
  count: number
): Promise<Array<string>> {
  const ourId = window.ConversationController.getOurConversationIdOrThrow();
  const messages = await DataReader.getOlderMessagesByConversation({
    conversationId: context.conversationId,
    includeStoryReplies: false,
    limit: count + context.excludeIds.size,
    storyId: undefined,
  });
  const lines: Array<string> = [];
  for (const message of messages) {
    if (context.excludeIds.has(message.id)) {
      continue;
    }
    const body = message.body?.trim();
    if (!body) {
      continue;
    }
    const authorId = isIncoming(message)
      ? window.ConversationController.lookupOrCreate({
          serviceId: message.sourceServiceId,
          e164: message.source,
          reason: 'sig/group_context',
        })?.id
      : ourId;
    const author = authorId
      ? window.ConversationController.get(authorId)?.getTitle({ isShort: true })
      : undefined;
    const text =
      body.length > GROUP_CONTEXT_LINE_MAX
        ? `${body.slice(0, GROUP_CONTEXT_LINE_MAX)}…`
        : body;
    lines.push(`[${author ?? 'someone'}] ${text}`);
  }
  return lines.slice(-count);
}

// Contract §5: the invocation record and its states. Phase 1 keeps the
// records in memory only; restart semantics (§5.2) therefore reduce to
// "nothing survives, nothing auto-replies".
export type SigInvocationState =
  | 'recognized'
  | 'question_enqueued'
  | 'inference_started'
  | 'final_ready'
  | 'reply_enqueued'
  | 'done'
  | 'cancelled'
  | 'failed_before_question'
  | 'failed_after_question'
  | 'suppressed'
  | 'reply_enqueue_failed';

export type SigInvocationRecord = {
  invocationId: string;
  conversationId: string;
  groupId: string;
  state: SigInvocationState;
  promptLength: number;
  questionMessageId?: string;
  answerMessageId?: string;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
};

const records = new Map<string, SigInvocationRecord>();

export function getSigInvocationRecords(): ReadonlyArray<SigInvocationRecord> {
  return Array.from(records.values());
}

function transition(
  record: SigInvocationRecord,
  state: SigInvocationState,
  error?: { code: string; message: string }
): void {
  // The record is the mutable store entry; Phase 1 keeps it in memory.
  Object.assign(record, { state, error, updatedAt: Date.now() });
  // §7.8: never log the prompt, the answer, or the group name.
  log.info(
    `invocation ${record.invocationId} -> ${state}${error ? ` (${error.code})` : ''}`
  );
}

export type SigPlan =
  | { kind: 'passthrough'; message: string }
  | {
      kind: 'reject';
      reason: 'empty_prompt' | 'too_long' | 'mesh_unavailable' | 'stopped';
      detail?: string;
    }
  | { kind: 'invoke'; record: SigInvocationRecord; prompt: string };

// Runs the structural gate (§2.2), the grammar (§2.1) and the preflight (§4).
// `passthrough` means "send exactly what a stock client would send" (possibly
// with the `\@sig` escape removed); `reject` means send nothing and keep the
// draft; `invoke` means the caller should post the question and then call
// `afterQuestionEnqueued`.
export async function planSigSend(
  conversation: ConversationModel,
  message: string,
  options: {
    bodyRanges?: DraftBodyRanges;
    hasAttachments: boolean;
    isViewOnce?: boolean;
    hasQuote: boolean;
  }
): Promise<SigPlan> {
  const parsed = parseSigInvocation(message);
  if (parsed.kind === 'decline') {
    if (parsed.reason === 'escaped') {
      return { kind: 'passthrough', message: parsed.text };
    }
    if (parsed.reason === 'not_sig') {
      return { kind: 'passthrough', message };
    }
    // Only applies when the text *is* an @sig attempt: structural gate first.
    if (!passesStructuralGate(conversation, options)) {
      return { kind: 'passthrough', message };
    }
    return { kind: 'reject', reason: parsed.reason };
  }

  if (!passesStructuralGate(conversation, options)) {
    return { kind: 'passthrough', message };
  }

  const groupId = conversation.get('groupId');
  if (!groupId) {
    return { kind: 'passthrough', message };
  }

  // `@sig stop`: cancel the in-flight ask in this group, post nothing.
  // Without an in-flight ask it is just chat (someone may mean the word).
  if (STOP_PROMPT.test(parsed.prompt)) {
    const askId = inflightByConversation.get(conversation.id);
    if (!askId) {
      return { kind: 'passthrough', message };
    }
    await ipcRenderer.invoke('sig:cancel', askId);
    log.info(`stop requested for ${askId}`);
    return { kind: 'reject', reason: 'stopped' };
  }

  const record: SigInvocationRecord = {
    invocationId: crypto.randomUUID(),
    conversationId: conversation.id,
    groupId,
    state: 'recognized',
    promptLength: parsed.prompt.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  records.set(record.invocationId, record);
  transition(record, 'recognized');

  const preflight = await runPreflight();
  if (!preflight.ok) {
    transition(record, 'failed_before_question', {
      code: 'preflight_failed',
      message: preflight.error,
    });
    return {
      kind: 'reject',
      reason: 'mesh_unavailable',
      detail: preflight.error,
    };
  }

  return { kind: 'invoke', record, prompt: parsed.prompt };
}

function passesStructuralGate(
  conversation: ConversationModel,
  options: {
    bodyRanges?: DraftBodyRanges;
    hasAttachments: boolean;
    isViewOnce?: boolean;
    hasQuote: boolean;
  }
): boolean {
  if (!isGroupV2(conversation.attributes)) {
    return false;
  }
  if (options.hasAttachments || options.isViewOnce || options.hasQuote) {
    return false;
  }
  if (options.bodyRanges?.some(range => BodyRange.isMention(range))) {
    return false;
  }
  return true;
}

async function runPreflight(): Promise<PreflightResult> {
  try {
    return (await ipcRenderer.invoke('sig:preflight')) as PreflightResult;
  } catch (error) {
    return { ok: false, error: Errors.toLogFormat(error) };
  }
}

// The question has been posted (or failed to). Runs inference and posts the
// reply. Never throws; everything is recorded on the invocation record.
export async function afterQuestionEnqueued(
  record: SigInvocationRecord,
  prompt: string,
  question: MessageAttributesType | undefined
): Promise<void> {
  if (!question) {
    transition(record, 'failed_before_question', {
      code: 'enqueue_returned_nothing',
      message: 'enqueueMessageForSend returned undefined',
    });
    return;
  }
  Object.assign(record, { questionMessageId: question.id });
  transition(record, 'question_enqueued');

  const conversation = window.ConversationController.get(record.conversationId);
  if (!conversation) {
    transition(record, 'failed_after_question', {
      code: 'conversation_missing',
      message: 'conversation disappeared',
    });
    return;
  }

  // While the model thinks the group sees the requester's ordinary typing
  // indicator — the same thing a stock client sends — and nothing else. The
  // requester additionally sees a local-only bubble that streams the answer.
  conversation.bumpTyping();
  const typing = setInterval(() => conversation.bumpTyping(), 2_000);
  transition(record, 'inference_started');

  const askId = record.invocationId;
  let bubble: SigLocalBubble | undefined;
  try {
    bubble = await SigLocalBubble.create(conversation, THINKING + STOP_HINT);
    bubbles.set(askId, bubble);
  } catch (error) {
    // The bubble is a courtesy; the invocation proceeds without it.
    log.error('local bubble failed', Errors.toLogFormat(error));
  }
  inflightByConversation.set(conversation.id, askId);
  askContext.set(askId, {
    conversationId: conversation.id,
    excludeIds: new Set(
      [question.id, bubble?.id].filter((id): id is string => Boolean(id))
    ),
  });

  let result: AskResult;
  try {
    result = (await ipcRenderer.invoke('sig:ask', prompt, askId)) as AskResult;
  } catch (error) {
    result = { ok: false, error: Errors.toLogFormat(error) };
  } finally {
    clearInterval(typing);
    bubbles.delete(askId);
    askContext.delete(askId);
    if (inflightByConversation.get(conversation.id) === askId) {
      inflightByConversation.delete(conversation.id);
    }
    await bubble?.remove();
  }

  if (!result.ok) {
    transition(record, 'failed_after_question', {
      code: 'inference_failed',
      message: result.error,
    });
    return;
  }
  if (result.cancelled) {
    // §5: cancel is local-only; the group sees nothing further.
    transition(record, 'cancelled');
    return;
  }
  transition(record, 'final_ready');

  // Destination gate (§6).
  const ourAci = itemStorage.user.getCheckedAci();
  const target = window.ConversationController.get(record.conversationId);
  if (
    !target ||
    target.get('groupId') !== record.groupId ||
    !isMember(target.attributes, ourAci) ||
    target.isBlocked() ||
    record.state !== 'final_ready'
  ) {
    transition(record, 'suppressed', {
      code: 'destination_gate',
      message: 'group changed, left, or blocked before the reply was ready',
    });
    return;
  }

  const requester =
    window.ConversationController.getOurConversationOrThrow().getTitle({
      isShort: true,
    });
  const header = `sig · requested by ${requester}`;
  let answer = result.answer.trim();
  if (answer.length === 0) {
    answer = '(no answer)';
  }
  if (answer.length > ANSWER_MAX_CHARS) {
    answer = `${answer.slice(0, ANSWER_MAX_CHARS)}… [truncated]`;
  }
  const body = `${header}\n\n${answer}`;
  const bodyRanges: DraftBodyRanges = [
    { start: 0, length: header.length, style: BodyRange.Style.BOLD },
  ];

  try {
    const quote = await makeQuote(question);
    const reply = await target.enqueueMessageForSend(
      { body, attachments: [], bodyRanges, quote },
      { dontClearDraft: true }
    );
    if (!reply) {
      transition(record, 'reply_enqueue_failed', {
        code: 'enqueue_returned_nothing',
        message: 'enqueueMessageForSend returned undefined',
      });
      return;
    }
    Object.assign(record, { answerMessageId: reply.id });
    transition(record, 'reply_enqueued');
    transition(record, 'done');
    log.info(
      `invocation ${record.invocationId} timings firstChunkMs=${result.firstChunkMs} totalMs=${result.totalMs} answerChars=${answer.length}`
    );
  } catch (error) {
    transition(record, 'reply_enqueue_failed', {
      code: 'enqueue_threw',
      message: Errors.toLogFormat(error),
    });
  }
}
