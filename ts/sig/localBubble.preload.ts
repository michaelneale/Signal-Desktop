// Copyright 2026 Michael Neale
// SPDX-License-Identifier: AGPL-3.0-only

// A local-only timeline bubble used while Sig is streaming an answer. It is a
// normal `outgoing` MessageModel that is saved and shown exactly the way
// Signal shows its own local notifications (ConversationModel.addNotification),
// but no send job is ever enqueued for it, so it can never reach the network.
// It is removed once the real reply is posted (or the ask is stopped).

import type { MessageAttributesType } from '../model-types.d.ts';
import type { ConversationModel } from '../models/conversations.preload.ts';
import { MessageModel } from '../models/messages.preload.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import { SeenStatus } from '../MessageSeenStatus.std.ts';
import { SendStatus } from '../messages/MessageSendState.std.ts';
import { DataWriter } from '../sql/Client.preload.ts';
import { cleanupMessages } from '../util/cleanup.preload.ts';
import { drop } from '../util/drop.std.ts';
import { generateMessageId } from '../util/generateMessageId.node.ts';
import { incrementMessageCounter } from '../util/incrementMessageCounter.preload.ts';
import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';

const log = createLogger('sig/localBubble');

// How often the streamed body is written to SQLite. Redux re-renders are
// already throttled per message by MessageCache (200 ms); the row only needs
// to be roughly current in case the app exits mid-stream.
const PERSIST_EVERY_MS = 1_500;

export class SigLocalBubble {
  readonly #model: MessageModel;
  #lastPersistedAt = Date.now();
  #removed = false;

  private constructor(model: MessageModel) {
    this.#model = model;
  }

  static async create(
    conversation: ConversationModel,
    body: string
  ): Promise<SigLocalBubble> {
    const now = Date.now();
    const ourConversationId =
      window.ConversationController.getOurConversationIdOrThrow();
    const attributes: MessageAttributesType = {
      ...generateMessageId(incrementMessageCounter()),
      conversationId: conversation.id,
      type: 'outgoing',
      body,
      timestamp: now,
      sent_at: now,
      received_at_ms: now,
      readStatus: ReadStatus.Read,
      seenStatus: SeenStatus.NotApplicable,
      // "Read by me" so the bubble shows no sending spinner. No job is ever
      // enqueued for this message, so nothing is sent.
      sendStateByConversationId: {
        [ourConversationId]: { status: SendStatus.Read, updatedAt: now },
      },
    };
    const model = new MessageModel(attributes);
    await window.MessageCache.saveMessage(model, { forceSave: true });
    const registered = window.MessageCache.register(model);
    drop(conversation.onNewMessage(registered));
    return new SigLocalBubble(registered);
  }

  get id(): string {
    return this.#model.id;
  }

  update(body: string): void {
    if (this.#removed) {
      return;
    }
    this.#model.set({ body });
    if (Date.now() - this.#lastPersistedAt >= PERSIST_EVERY_MS) {
      this.#lastPersistedAt = Date.now();
      drop(window.MessageCache.saveMessage(this.#model));
    }
  }

  async remove(): Promise<void> {
    if (this.#removed) {
      return;
    }
    this.#removed = true;
    try {
      await DataWriter.removeMessageById(this.#model.id, {
        fromSync: true,
        cleanupMessages,
      });
    } catch (error) {
      log.error('remove failed', Errors.toLogFormat(error));
    }
  }
}
