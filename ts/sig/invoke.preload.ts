// Copyright 2026 Signal Messenger, LLC
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
import { parseSigInvocation } from './parse.std.ts';

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
    }
  | { ok: false; error: string };

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
      reason: 'empty_prompt' | 'too_long' | 'mesh_unavailable';
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
  // indicator — the same thing a stock client sends — and nothing else.
  conversation.bumpTyping();
  const typing = setInterval(() => conversation.bumpTyping(), 2_000);
  transition(record, 'inference_started');

  let result: AskResult;
  try {
    result = (await ipcRenderer.invoke('sig:ask', prompt)) as AskResult;
  } catch (error) {
    result = { ok: false, error: Errors.toLogFormat(error) };
  } finally {
    clearInterval(typing);
  }

  if (!result.ok) {
    transition(record, 'failed_after_question', {
      code: 'inference_failed',
      message: result.error,
    });
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
