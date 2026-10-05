// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Main-process side of the Phase 1 Sig loop: owns the single SigMeshWorker,
// runs the launch-time preflight, and exposes `sig:preflight` / `sig:ask` to
// the renderer over IPC. Nothing here touches Signal messages — the renderer
// (ts/sig/invoke.preload.ts) decides what gets posted.

import { ipcMain as ipc } from 'electron';
import type { WebContents } from 'electron';
import { createLogger } from '../logging/log.std.ts';
import * as Errors from '../types/errors.std.ts';
import { drop } from '../util/drop.std.ts';
import { SigMeshWorker } from './meshMain.main.ts';

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
    }
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

  const startedAt = Date.now();
  let firstChunkAt: number | undefined;
  try {
    const { requestId } = await mesh.call('chat', model, [
      {
        role: 'system',
        content:
          'You are Sig, an assistant inside a Signal group chat. Answer the question directly and concisely in plain text, in at most three short paragraphs. No markdown.',
      },
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
  ipc.handle('sig:cancel', (_event, askId: unknown) => {
    if (typeof askId !== 'string') {
      return { cancelled: false };
    }
    return cancel(askId);
  });

  return preflight;
}
