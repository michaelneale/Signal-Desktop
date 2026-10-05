// Copyright 2026 Michael Neale
// SPDX-License-Identifier: AGPL-3.0-only

import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('Sig mesh worker must run in a worker thread');
}

const port = parentPort;
let client: any;
const requests = new Map<string, AsyncGenerator<any, void, unknown>>();

function sdk(): any {
  const sdkPath = process.env.SIG_MESH_SDK_PATH;
  if (!sdkPath) {
    throw new Error('SIG_MESH_SDK_PATH is required');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(sdkPath);
}

function respond(seq: number, response?: unknown, error?: unknown): void {
  port.postMessage({
    type: 'response',
    seq,
    response,
    error:
      error instanceof Error
        ? (error.stack ?? error.message)
        : error
          ? String(error)
          : undefined,
  });
}

async function handle(
  seq: number,
  method: string,
  args: ReadonlyArray<any>
): Promise<void> {
  if (method === 'start') {
    const { Client, generateOwnerKeypairHex } = sdk();
    client = Client.create({
      ownerKeypairHex: args[0] ?? generateOwnerKeypairHex(),
      inviteToken: args[1],
    });
    await client.start();
    respond(seq, { versions: process.versions });
    return;
  }
  if (method === 'crash') {
    respond(seq);
    setImmediate(() => {
      throw new Error('Intentional Sig mesh worker crash');
    });
    return;
  }
  if (!client) {
    throw new Error('Sig mesh client is not started');
  }
  if (method === 'status') {
    respond(seq, await client.status());
  } else if (method === 'listModels') {
    respond(seq, await client.inference.listModels());
  } else if (method === 'chat') {
    const requestId = crypto.randomUUID();
    const iterator = client.inference.streamChatCompletions({
      model: args[0],
      messages: args[1],
    });
    requests.set(requestId, iterator);
    respond(seq, { requestId });
    void (async () => {
      try {
        for await (const event of iterator) {
          if (event.type !== 'sse' || event.done) continue;
          port.postMessage({ type: 'chunk', requestId, data: event.json() });
        }
        port.postMessage({ type: 'done', requestId });
      } catch (error) {
        port.postMessage({ type: 'error', requestId, error: String(error) });
      } finally {
        requests.delete(requestId);
      }
    })();
  } else if (method === 'cancel') {
    const iterator = requests.get(args[0]);
    await iterator?.return(undefined);
    respond(seq, { cancelled: Boolean(iterator) });
  } else if (method === 'stop') {
    await client.stop();
    client = undefined;
    respond(seq);
  } else {
    throw new Error(`Unknown Sig mesh worker method: ${method}`);
  }
}

port.on('message', ({ seq, method, args = [] }) => {
  void handle(seq, method, args).catch(error => respond(seq, undefined, error));
});
