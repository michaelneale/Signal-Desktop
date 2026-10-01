// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { getAppRootDir } from '../util/appRootDir.main.ts';

export class SigMeshWorker {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  readonly #events = new Map<string, Array<any>>();
  #seq = 0;

  constructor() {
    this.#worker = new Worker(join(getAppRootDir(), 'bundles', 'workers', 'mesh.js'));
    this.#worker.on('error', error => {
      console.error('Sig mesh worker error', error);
    });
    this.#worker.on('message', message => {
      if (message.type !== 'response') {
        const events = this.#events.get(message.requestId) ?? [];
        events.push(message);
        this.#events.set(message.requestId, events);
        return;
      }
      const pending = this.#pending.get(message.seq);
      this.#pending.delete(message.seq);
      if (!pending) return;
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.response);
    });
    this.#worker.once('exit', code => {
      const error = new Error(`Sig mesh worker exited with code ${code}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      console.error(error.message);
    });
  }

  call(method: string, ...args: ReadonlyArray<any>): Promise<any> {
    const seq = ++this.#seq;
    const result = new Promise((resolve, reject) => this.#pending.set(seq, { resolve, reject }));
    this.#worker.postMessage({ seq, method, args });
    return result;
  }

  events(requestId: string): ReadonlyArray<any> {
    return this.#events.get(requestId) ?? [];
  }
}
