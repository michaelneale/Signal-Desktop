// Copyright 2026 Michael Neale
// SPDX-License-Identifier: AGPL-3.0-only

// Main-process owner of the `sig-agent` sidecar (rust/sig-agent): a GDK
// (goose) agent loop that talks to a mesh host and hands every tool call back
// to us over stdio. One process for the app's lifetime, one JSON object per
// line in each direction; see rust/sig-agent/src/main.rs for the wire.

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';

const log = createLogger('sig/agent');

export type SigAgentToolCall = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type SigAgentTurnHandlers = {
  onDelta: (text: string) => void;
  // Must resolve with the tool's text result, or reject; a rejection is
  // reported to the model as a tool error (it is not fatal to the turn).
  onToolCall: (call: SigAgentToolCall) => Promise<string>;
};

export type SigAgentTurnResult =
  | { kind: 'done'; text: string; rounds: number; toolCalls: number }
  | { kind: 'cancelled' };

// stdout events from the sidecar; `id` is the turn id we minted.
type AgentEvent =
  | { type: 'ready'; goose_rev: string; tools: Array<string> }
  | { type: 'delta'; id: string; text: string }
  | {
      type: 'tool_call';
      id: string;
      call_id: string;
      name: string;
      args?: Record<string, unknown>;
    }
  | {
      type: 'done';
      id: string;
      text: string;
      rounds: number;
      tool_calls: number;
    }
  | { type: 'cancelled'; id: string }
  | { type: 'error'; id: string; error: string };

type Pending = {
  handlers: SigAgentTurnHandlers;
  resolve: (result: SigAgentTurnResult) => void;
  reject: (error: Error) => void;
};

export class SigAgentProcess {
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  readonly #pending = new Map<string, Pending>();
  readonly ready: Promise<{ gooseRev: string; tools: ReadonlyArray<string> }>;
  #exited: Error | undefined;

  constructor(binary: string, baseUrl: string) {
    this.#child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, SIG_AGENT_BASE_URL: baseUrl },
    });
    let resolveReady: (value: {
      gooseRev: string;
      tools: ReadonlyArray<string>;
    }) => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    createInterface({ input: this.#child.stdout }).on('line', line => {
      let event: AgentEvent;
      try {
        event = JSON.parse(line) as AgentEvent;
      } catch {
        log.warn(`unparseable line from sig-agent: ${line.slice(0, 200)}`);
        return;
      }
      if (event.type === 'ready') {
        log.info(
          `sig-agent ready goose=${event.goose_rev} tools=${event.tools.join(',')}`
        );
        resolveReady({ gooseRev: event.goose_rev, tools: event.tools });
        return;
      }
      const pending = this.#pending.get(event.id);
      if (!pending) {
        if (event.type === 'error') {
          log.error(`sig-agent: ${event.error}`);
        }
        return;
      }
      if (event.type === 'delta') {
        pending.handlers.onDelta(event.text);
      } else if (event.type === 'tool_call') {
        this.#runTool(event.id, pending, {
          callId: event.call_id,
          name: event.name,
          args: event.args ?? {},
        });
      } else if (event.type === 'done') {
        this.#pending.delete(event.id);
        pending.resolve({
          kind: 'done',
          text: event.text,
          rounds: event.rounds,
          toolCalls: event.tool_calls,
        });
      } else if (event.type === 'cancelled') {
        this.#pending.delete(event.id);
        pending.resolve({ kind: 'cancelled' });
      } else if (event.type === 'error') {
        this.#pending.delete(event.id);
        pending.reject(new Error(event.error));
      }
    });

    this.#child.once('exit', code => {
      this.#exited = new Error(`sig-agent exited with code ${code}`);
      log.error(this.#exited.message);
      rejectReady(this.#exited);
      for (const pending of this.#pending.values()) {
        pending.reject(this.#exited);
      }
      this.#pending.clear();
    });
    this.#child.once('error', error => {
      log.error('sig-agent spawn failed', Errors.toLogFormat(error));
      rejectReady(error);
    });
  }

  #runTool(id: string, pending: Pending, call: SigAgentToolCall): void {
    void (async () => {
      let message: Record<string, unknown>;
      try {
        const content = await pending.handlers.onToolCall(call);
        message = { type: 'tool_result', id, call_id: call.callId, content };
      } catch (error) {
        message = {
          type: 'tool_result',
          id,
          call_id: call.callId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      this.#write(message);
    })();
  }

  #write(message: Record<string, unknown>): void {
    if (this.#exited) {
      return;
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  turn(
    id: string,
    options: {
      model: string;
      system: string;
      prompt: string;
      maxRounds: number;
    },
    handlers: SigAgentTurnHandlers
  ): Promise<SigAgentTurnResult> {
    if (this.#exited) {
      return Promise.reject(this.#exited);
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { handlers, resolve, reject });
      this.#write({
        type: 'turn',
        id,
        model: options.model,
        system: options.system,
        prompt: options.prompt,
        max_rounds: options.maxRounds,
      });
    });
  }

  cancel(id: string): void {
    this.#write({ type: 'cancel', id });
  }

  stop(): void {
    this.#child.kill();
  }
}
