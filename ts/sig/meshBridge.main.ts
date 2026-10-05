// Copyright 2026 Michael Neale
// SPDX-License-Identifier: AGPL-3.0-only

// Main-process side of the Phase 1 Sig loop: owns the single SigMeshWorker,
// runs the launch-time preflight, and exposes `sig:preflight` / `sig:ask` to
// the renderer over IPC. Nothing here touches Signal messages — the renderer
// (ts/sig/invoke.preload.ts) decides what gets posted.

import { BrowserWindow, dialog, ipcMain as ipc } from 'electron';
import type { WebContents } from 'electron';
import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';
import { drop } from '../util/drop.std.ts';
import { SigMeshWorker } from './meshMain.main.ts';
import { SigAgentProcess } from './agent.node.ts';
import type { SigAgentToolCall } from './agent.node.ts';

const log = createLogger('sig/meshBridge');

export type SigMeshPreflightResult =
  | { ok: true; models: ReadonlyArray<string> }
  | { ok: false; error: string };

export type SigAskResult =
  | {
      ok: true;
      model: string;
      answer: string;
      firstChunkMs: number;
      totalMs: number;
      cancelled: boolean;
      // Set on the GDK agent path: how many tool calls the model made.
      toolCalls?: number;
    }
  | { ok: false; error: string };

// Sent to the renderer on `sig:tool` when the agent asks for a tool; the
// renderer answers with `sig:tool_result`. Consent has already been given by
// the time this is sent.
export type SigToolRequest = {
  askId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
};
export type SigToolResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

// Streamed to the renderer on the `sig:chunk` channel while an ask is in
// flight; `text` is the visible answer so far (thinking stripped), not a delta.
export type SigChunk = { askId: string; text: string };

// askId (minted by the renderer) -> mesh worker requestId, for cancel.
const inflight = new Map<string, string>();
const cancelled = new Set<string>();

const PREFLIGHT_TIMEOUT_MS = 3_000;
const ASK_TIMEOUT_MS = 120_000;
const POLL_MS = 50;

let worker: SigMeshWorker | undefined;
let preflight: Promise<SigMeshPreflightResult> | undefined;
// Present when SIG_AGENT_BIN and SIG_AGENT_BASE_URL are set: asks run through
// the GDK agent loop (rust/sig-agent) instead of a single chat completion.
let agent: SigAgentProcess | undefined;
// `${askId}:${callId}` -> resolver for the renderer's tool result.
const toolResults = new Map<string, (result: SigToolResult) => void>();

const SYSTEM_PROMPT =
  'You are Sig, an assistant inside a Signal group chat. Answer the question directly and concisely in plain text, in at most three short paragraphs. No markdown.';
const AGENT_SYSTEM_PROMPT = `${SYSTEM_PROMPT} If the question is about this conversation (what was said, decided, or planned), call the group_context tool first and answer from what it returns. Otherwise answer from your own knowledge without tools.`;
const AGENT_MAX_ROUNDS = 4;
const GROUP_CONTEXT_DEFAULT = 20;
const GROUP_CONTEXT_MAX = 50;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runPreflight(
  mesh: SigMeshWorker,
  inviteToken: string
): Promise<SigMeshPreflightResult> {
  try {
    await mesh.call('start', null, inviteToken);
    return modelsResult(await mesh.call('listModels'));
  } catch (error) {
    return { ok: false, error: Errors.toLogFormat(error) };
  }
}

// A host that answers but advertises nothing (still loading its model, or a
// client-only node) is not a usable mesh: the question must not be posted.
function modelsResult(
  models: ReadonlyArray<{ id: string }>
): SigMeshPreflightResult {
  const ids = orderModels(models.map(model => model.id));
  if (ids.length === 0) {
    return { ok: false, error: 'mesh advertised no models' };
  }
  return { ok: true, models: ids };
}

// SIG_MESH_MODEL (optional) names the preferred model; it is moved to the
// front so `models[0]` stays the single selection rule (contract §4).
function orderModels(ids: ReadonlyArray<string>): Array<string> {
  const preferred = process.env.SIG_MESH_MODEL;
  if (!preferred || !ids.includes(preferred)) {
    return [...ids];
  }
  return [preferred, ...ids.filter(id => id !== preferred)];
}

// Re-checks the mesh right before a question is posted (contract §4): a warm
// listModels() round-trip bounded by PREFLIGHT_TIMEOUT_MS. Never rejects.
async function checkMesh(): Promise<SigMeshPreflightResult> {
  if (!worker || !preflight) {
    return { ok: false, error: 'Sig mesh worker is not enabled' };
  }
  const launch = await preflight;
  if (!launch.ok) {
    return launch;
  }
  try {
    return modelsResult(
      await withTimeout(
        worker.call('listModels'),
        PREFLIGHT_TIMEOUT_MS,
        'listModels'
      )
    );
  } catch (error) {
    return { ok: false, error: Errors.toLogFormat(error) };
  }
}

function extractDelta(chunk: unknown): string {
  const data = (
    chunk as { data?: { choices?: Array<{ delta?: { content?: string } }> } }
  ).data;
  return data?.choices?.[0]?.delta?.content ?? '';
}

// Qwen3 and friends emit <think>…</think> before the answer; the group should
// only see the answer.
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gu, '').trim();
}

async function ask(
  prompt: string,
  askId: string,
  sender: WebContents
): Promise<SigAskResult> {
  const mesh = worker;
  if (!mesh) {
    return { ok: false, error: 'Sig mesh worker is not enabled' };
  }
  const check = await checkMesh();
  if (!check.ok) {
    return check;
  }
  const model = check.models[0];
  if (!model) {
    return { ok: false, error: 'mesh advertised no models' };
  }

  if (agent) {
    return askAgent(agent, prompt, askId, sender, model);
  }

  const startedAt = Date.now();
  let firstChunkAt: number | undefined;
  try {
    const { requestId } = await mesh.call('chat', model, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ]);
    inflight.set(askId, requestId);
    if (cancelled.has(askId)) {
      // Stop arrived before the request id existed.
      await mesh.call('cancel', requestId);
    }
    const answer = await withTimeout(
      new Promise<string>((resolve, reject) => {
        let seen = 0;
        let sentText = '';
        const timer = setInterval(() => {
          const events = mesh.events(requestId);
          if (
            firstChunkAt === undefined &&
            events.some(event => event.type === 'chunk')
          ) {
            firstChunkAt = Date.now();
          }
          const failure = events.find(event => event.type === 'error');
          if (failure) {
            clearInterval(timer);
            reject(new Error(String(failure.error ?? 'chat failed')));
            return;
          }
          if (events.length > seen) {
            seen = events.length;
            const text = visibleText(events.map(extractDelta).join(''));
            if (text !== sentText && !sender.isDestroyed()) {
              sentText = text;
              const chunk: SigChunk = { askId, text };
              sender.send('sig:chunk', chunk);
            }
          }
          if (events.some(event => event.type === 'done')) {
            clearInterval(timer);
            resolve(events.map(extractDelta).join(''));
          }
        }, POLL_MS);
      }),
      ASK_TIMEOUT_MS,
      'chat'
    );
    const totalMs = Date.now() - startedAt;
    const wasCancelled = cancelled.has(askId);
    log.info(
      `ask: model=${model} chars=${answer.length} firstChunkMs=${(firstChunkAt ?? startedAt) - startedAt} totalMs=${totalMs} cancelled=${wasCancelled}`
    );
    return {
      ok: true,
      model,
      answer: stripThinking(answer),
      firstChunkMs: (firstChunkAt ?? startedAt) - startedAt,
      totalMs,
      cancelled: wasCancelled,
    };
  } catch (error) {
    log.error('ask failed', Errors.toLogFormat(error));
    return { ok: false, error: Errors.toLogFormat(error) };
  } finally {
    inflight.delete(askId);
    cancelled.delete(askId);
  }
}

// The GDK agent path. The loop (rounds, cancellation) is the sidecar's; what
// stays here is everything that touches the requester: streaming the visible
// text, asking before a tool reads anything, and routing the read to the
// renderer, which is the only place Signal messages are reachable.
async function askAgent(
  loop: SigAgentProcess,
  prompt: string,
  askId: string,
  sender: WebContents,
  model: string
): Promise<SigAskResult> {
  const startedAt = Date.now();
  let firstChunkAt: number | undefined;
  inflight.set(askId, askId);
  if (cancelled.has(askId)) {
    return {
      ok: true,
      model,
      answer: '',
      firstChunkMs: 0,
      totalMs: 0,
      cancelled: true,
    };
  }
  try {
    const result = await withTimeout(
      loop.turn(
        askId,
        {
          model,
          system: AGENT_SYSTEM_PROMPT,
          prompt,
          maxRounds: AGENT_MAX_ROUNDS,
        },
        {
          onDelta: text => {
            firstChunkAt ??= Date.now();
            if (!sender.isDestroyed()) {
              const chunk: SigChunk = { askId, text };
              sender.send('sig:chunk', chunk);
            }
          },
          onToolCall: call => runTool(call, askId, sender),
        }
      ),
      ASK_TIMEOUT_MS,
      'agent turn'
    );
    const totalMs = Date.now() - startedAt;
    if (result.kind === 'cancelled') {
      log.info(`askAgent: cancelled totalMs=${totalMs}`);
      return {
        ok: true,
        model,
        answer: '',
        firstChunkMs: 0,
        totalMs,
        cancelled: true,
      };
    }
    log.info(
      `askAgent: model=${model} chars=${result.text.length} rounds=${result.rounds} toolCalls=${result.toolCalls} firstChunkMs=${(firstChunkAt ?? startedAt) - startedAt} totalMs=${totalMs}`
    );
    return {
      ok: true,
      model,
      answer: result.text,
      firstChunkMs: (firstChunkAt ?? startedAt) - startedAt,
      totalMs,
      cancelled: cancelled.has(askId),
      toolCalls: result.toolCalls,
    };
  } catch (error) {
    log.error('askAgent failed', Errors.toLogFormat(error));
    loop.cancel(askId);
    return { ok: false, error: Errors.toLogFormat(error) };
  } finally {
    inflight.delete(askId);
    cancelled.delete(askId);
  }
}

// Every tool the model asks for goes through here. Only `group_context` exists;
// it needs the requester's explicit yes (a native dialog on this device) before
// the renderer reads anything. SIG_AGENT_CONSENT=allow|deny skips the dialog
// for the mock harness. A refusal is reported to the model as a tool error.
async function runTool(
  call: SigAgentToolCall,
  askId: string,
  sender: WebContents
): Promise<string> {
  if (call.name !== 'group_context') {
    throw new Error(`unknown tool ${call.name}`);
  }
  const requested = Number(call.args.count);
  const count = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), GROUP_CONTEXT_MAX)
    : GROUP_CONTEXT_DEFAULT;
  if (!(await consentToRead(count, sender))) {
    log.info(`runTool: group_context(${count}) denied by requester`);
    throw new Error(
      'The requester declined to share the conversation. Answer without it, or say you need it.'
    );
  }
  log.info(`runTool: group_context(${count}) approved`);
  const key = `${askId}:${call.callId}`;
  let result: SigToolResult;
  try {
    result = await withTimeout(
      new Promise<SigToolResult>(resolve => {
        toolResults.set(key, resolve);
        const request: SigToolRequest = {
          askId,
          callId: call.callId,
          name: call.name,
          args: { count },
        };
        sender.send('sig:tool', request);
      }),
      PREFLIGHT_TIMEOUT_MS * 5,
      'group_context'
    );
  } finally {
    toolResults.delete(key);
  }
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.content;
}

async function consentToRead(
  count: number,
  sender: WebContents
): Promise<boolean> {
  const policy = process.env.SIG_AGENT_CONSENT;
  if (policy === 'allow') return true;
  if (policy === 'deny') return false;
  const window = BrowserWindow.fromWebContents(sender);
  const options = {
    type: 'question' as const,
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    message: `sig wants to read the last ${count} messages in this group`,
    detail:
      'They are read on this device only and sent to the mesh model host together with your question. Nothing extra is posted to the group.',
  };
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

// Thinking is stripped once closed; while the model is still inside a
// <think> block the visible text is whatever preceded it (usually nothing).
function visibleText(raw: string): string {
  const open = raw.lastIndexOf('<think>');
  const close = raw.lastIndexOf('</think>');
  if (open !== -1 && close < open) {
    return stripThinking(raw.slice(0, open));
  }
  return stripThinking(raw);
}

async function cancel(askId: string): Promise<{ cancelled: boolean }> {
  cancelled.add(askId);
  const requestId = inflight.get(askId);
  if (!worker || !requestId) {
    return { cancelled: false };
  }
  if (agent && requestId === askId) {
    agent.cancel(askId);
    return { cancelled: true };
  }
  try {
    return await worker.call('cancel', requestId);
  } catch (error) {
    log.error('cancel failed', Errors.toLogFormat(error));
    return { cancelled: false };
  }
}

// Called once from app.on('ready') when SIG_MESH_WORKER=1. Returns the
// launch-time preflight promise (used by the CI `sig-mesh-preflight` event).
export function startSigMeshBridge(
  inviteToken: string
): Promise<SigMeshPreflightResult> {
  worker = new SigMeshWorker();
  preflight = runPreflight(worker, inviteToken);
  const agentBin = process.env.SIG_AGENT_BIN;
  const agentBaseUrl = process.env.SIG_AGENT_BASE_URL;
  if (agentBin && agentBaseUrl) {
    agent = new SigAgentProcess(agentBin, agentBaseUrl);
    const started = agent;
    drop(
      (async () => {
        try {
          log.info('agent ready', await started.ready);
        } catch (error) {
          log.error('agent failed to start', Errors.toLogFormat(error));
        }
      })()
    );
  } else if (agentBin || agentBaseUrl) {
    log.error('SIG_AGENT_BIN and SIG_AGENT_BASE_URL must both be set');
  }
  drop(
    (async () => {
      log.info('preflight', await preflight);
    })()
  );

  ipc.handle('sig:preflight', () => checkMesh());
  ipc.handle('sig:ask', (event, prompt: unknown, askId: unknown) => {
    if (typeof prompt !== 'string' || typeof askId !== 'string') {
      return { ok: false, error: 'prompt and askId must be strings' };
    }
    return ask(prompt, askId, event.sender);
  });
  ipc.handle(
    'sig:tool_result',
    (_event, askId: unknown, callId: unknown, result: unknown) => {
      if (typeof askId !== 'string' || typeof callId !== 'string') {
        return;
      }
      toolResults.get(`${askId}:${callId}`)?.(result as SigToolResult);
    }
  );
  ipc.handle('sig:cancel', (_event, askId: unknown) => {
    if (typeof askId !== 'string') {
      return { cancelled: false };
    }
    return cancel(askId);
  });

  return preflight;
}
