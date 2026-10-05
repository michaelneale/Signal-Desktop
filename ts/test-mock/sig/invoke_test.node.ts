// Copyright 2026 Michael Neale
// SPDX-License-Identifier: AGPL-3.0-only

// Phase 1 Sig loop end to end on the mock server: two linked Desktop
// instances share a group; the first types `@sig <question>`, the second (a
// stock-behaving peer) must see the question *and* a quoted reply, and must
// never run inference itself. Requires a live private mesh host:
//
//   SIGNAL_MOCK_TESTS_BACKGROUND=1 SIG_MESH_WORKER=1 SIG_MESH_SDK_PATH=… \
//   SIG_MESH_INVITE=… mocha --require ts/test-mock/setup-ci.node.ts \
//     ts/test-mock/sig/invoke_test.node.ts
//
// Set SIG_DEMO_FRAMES_DIR to capture both windows every 500 ms as PNG frames
// (stitch with ffmpeg; Playwright's recordVideo stalls Electron startup when
// the screen is locked, screenshots do not).

import { StorageState } from '@signalapp/mock-server';
import type { Group } from '@signalapp/mock-server';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import createDebug from 'debug';
import * as durations from '../../util/durations/index.std.ts';
import type { App } from '../playwright.node.ts';
import { Bootstrap } from '../bootstrap.node.ts';
import { typeIntoInput, waitForEnabledComposer } from '../helpers.node.ts';
import type { Page } from 'playwright';
import { drop } from '../../util/drop.std.ts';

function startFrameCapture(pages: ReadonlyArray<Page>): () => void {
  const dir = process.env.SIG_DEMO_FRAMES_DIR;
  if (!dir) {
    return () => undefined;
  }
  let frame = 0;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) {
      return;
    }
    busy = true;
    const index = String(frame).padStart(4, '0');
    frame += 1;
    drop(
      (async () => {
        try {
          await Promise.all(
            pages.map(async (page, i) => {
              try {
                await page.screenshot({
                  path: path.join(dir, `w${i}-${index}.png`),
                });
              } catch {
                // window may be mid-teardown
              }
            })
          );
        } finally {
          busy = false;
        }
      })()
    );
  }, 500);
  return () => clearInterval(timer);
}

const debug = createDebug('mock:test:sig:invoke');

describe('sig invoke', function sigInvoke(this: Mocha.Suite) {
  this.timeout(3 * durations.MINUTE);

  before(function skipWithoutMesh(this: Mocha.Context) {
    if (process.env.SIG_MESH_WORKER !== '1') {
      this.skip();
    }
  });

  let bootstrap1: Bootstrap;
  let bootstrap2: Bootstrap;
  let app1: App;
  let app2: App;
  let group: Group;

  const UP_TEST = 'posts the question and one quoted reply into the group';
  const STOP_TEST = 'stops on @sig stop and posts nothing further';
  const DOWN_TEST = 'sends nothing when the mesh is unreachable';
  const TEST_FOR_EXPECT: Record<string, string> = {
    up: UP_TEST,
    stop: STOP_TEST,
    down: DOWN_TEST,
  };

  beforeEach(async function before(this: Mocha.Context) {
    // Pick the one test matching SIG_MESH_EXPECT before launching anything.
    const wanted = TEST_FOR_EXPECT[process.env.SIG_MESH_EXPECT ?? 'up'];
    if (this.currentTest?.title !== wanted) {
      this.skip();
    }
    bootstrap1 = new Bootstrap();
    await bootstrap1.init();

    bootstrap2 = new Bootstrap({ server: bootstrap1.server });
    await bootstrap2.init();

    const phone1 = bootstrap1.phone;
    const phone2 = bootstrap2.phone;

    group = await phone1.createGroup({
      title: 'Sig demo',
      members: [phone1, phone2],
    });

    const state1 = StorageState.getEmpty()
      .updateAccount({
        profileKey: phone1.profileKey.serialize(),
      })
      .addContact(phone2, {
        whitelisted: true,
        profileKey: phone2.profileKey.serialize(),
      })
      .addGroup(group, { whitelisted: true })
      .pinGroup(group);
    await phone1.setStorageState(state1);

    const state2 = StorageState.getEmpty()
      .updateAccount({
        profileKey: phone2.profileKey.serialize(),
      })
      .addContact(phone1, {
        whitelisted: true,
        profileKey: phone1.profileKey.serialize(),
      })
      .addGroup(group, { whitelisted: true })
      .pinGroup(group);
    await phone2.setStorageState(state2);

    app1 = await bootstrap1.link();
    app2 = await bootstrap2.link();
  });

  afterEach(async function after(this: Mocha.Context) {
    if (!bootstrap1 || this.currentTest?.state === 'pending') {
      return;
    }
    await bootstrap1.maybeSaveLogs(this.currentTest, app1);
    await bootstrap2.maybeSaveLogs(this.currentTest, app2);

    await app2.close();
    await app1.close();

    await bootstrap2.teardown();
    await bootstrap1.teardown();
  });

  it(UP_TEST, async () => {
    const [pre1, pre2] = await Promise.all([
      app1.waitForSigMeshPreflight(),
      app2.waitForSigMeshPreflight(),
    ]);
    assert(pre1.ok, `app1 preflight: ${JSON.stringify(pre1)}`);
    assert(pre2.ok, `app2 preflight: ${JSON.stringify(pre2)}`);

    const window1 = await app1.getWindow();
    const window2 = await app2.getWindow();
    const stopFrames = startFrameCapture([window1, window2]);

    debug('open group on both clients');
    await window1
      .locator('#LeftPane')
      .locator(`[data-testid="${group.id}"]`)
      .click();
    await window2
      .locator('#LeftPane')
      .locator(`[data-testid="${group.id}"]`)
      .click();

    // A1: @sig not at the beginning is a plain message.
    const plain = 'hello @sig this is just chat';
    const composer1 = await waitForEnabledComposer(window1);
    await typeIntoInput(composer1, plain, '');
    await composer1.press('Enter');
    await window2.locator(`.module-message__text >> "${plain}"`).waitFor();

    // A4: the real thing.
    const question = '@sig What is the capital of France? One sentence.';
    debug('send @sig question');
    await typeIntoInput(await waitForEnabledComposer(window1), question, '');
    await (await waitForEnabledComposer(window1)).press('Enter');

    debug('peer sees the question verbatim');
    await window2.locator(`.module-message__text >> "${question}"`).waitFor();

    debug('requester sees the local streaming bubble');
    const streaming1 = window1
      .locator('.module-message--outgoing')
      .filter({ hasText: 'type @sig stop to cancel' });
    await streaming1.waitFor({ timeout: 30 * durations.SECOND });

    debug('peer sees the labelled reply quoting the question');
    const reply2 = window2
      .locator('.module-message--incoming')
      .filter({ hasText: 'sig · requested by' })
      .filter({ hasText: 'Paris' });
    await reply2.waitFor({ timeout: 90 * durations.SECOND });
    await reply2
      .locator('.module-quote')
      .filter({ hasText: question })
      .waitFor();

    debug('requester sees it as outgoing');
    await window1
      .locator('.module-message--outgoing')
      .filter({ hasText: 'sig · requested by' })
      .filter({ hasText: 'Paris' })
      .waitFor();

    debug('the local streaming bubble is gone once the reply is posted');
    await streaming1.waitFor({
      state: 'detached',
      timeout: 10 * durations.SECOND,
    });
    assert.strictEqual(
      await window2
        .locator('.module-message')
        .filter({ hasText: 'type @sig stop to cancel' })
        .count(),
      0,
      'peer saw the local bubble'
    );

    // Exactly one reply, and A8: the peer never ran inference.
    assert.strictEqual(
      await window2
        .locator('.module-message')
        .filter({ hasText: 'sig · requested by' })
        .count(),
      1
    );
    const main2 = await readFile(
      path.join(bootstrap2.logsDir, 'main.log'),
      'utf8'
    );
    assert(!main2.includes('ask: model='), 'peer ran inference');
    const main1 = await readFile(
      path.join(bootstrap1.logsDir, 'main.log'),
      'utf8'
    );
    assert(main1.includes('ask: model='), 'requester did not run inference');

    // Linger so the recording shows the settled state.
    if (process.env.SIG_DEMO_FRAMES_DIR) {
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
    stopFrames();
  });

  // `@sig stop` while Sig is answering: the question is posted, the local
  // bubble disappears, the stop command itself is never posted, and no reply
  // ever reaches the group.
  it(STOP_TEST, async () => {
    const pre1 = await app1.waitForSigMeshPreflight();
    assert(pre1.ok, `app1 preflight: ${JSON.stringify(pre1)}`);

    const window1 = await app1.getWindow();
    const window2 = await app2.getWindow();
    const stopFrames = startFrameCapture([window1, window2]);
    await window1
      .locator('#LeftPane')
      .locator(`[data-testid="${group.id}"]`)
      .click();
    await window2
      .locator('#LeftPane')
      .locator(`[data-testid="${group.id}"]`)
      .click();

    const question =
      '@sig Write a 400 word essay about the history of Paris, no headings.';
    await typeIntoInput(await waitForEnabledComposer(window1), question, '');
    await (await waitForEnabledComposer(window1)).press('Enter');
    await window2.locator(`.module-message__text >> "${question}"`).waitFor();

    const streaming1 = window1
      .locator('.module-message--outgoing')
      .filter({ hasText: 'type @sig stop to cancel' });
    await streaming1.waitFor({ timeout: 30 * durations.SECOND });

    debug('stop it');
    await typeIntoInput(await waitForEnabledComposer(window1), '@sig stop', '');
    await (await waitForEnabledComposer(window1)).press('Enter');
    await window1
      .locator('.Toast')
      .filter({ hasText: 'Sig stopped' })
      .waitFor();
    await streaming1.waitFor({
      state: 'detached',
      timeout: 15 * durations.SECOND,
    });

    // Give a would-be reply ample time to arrive, then prove it did not.
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const counts = await Promise.all(
      [window1, window2].flatMap(window => [
        window.locator('.module-message__text >> "@sig stop"').count(),
        window
          .locator('.module-message')
          .filter({ hasText: 'sig · requested by' })
          .count(),
      ])
    );
    assert.deepStrictEqual(
      counts,
      [0, 0, 0, 0],
      'stop command or a reply was posted'
    );
    const main1 = await readFile(
      path.join(bootstrap1.logsDir, 'main.log'),
      'utf8'
    );
    assert(main1.includes('cancelled=true'), 'ask was not cancelled');
    const app1Log = await readFile(
      path.join(bootstrap1.logsDir, 'app.log'),
      'utf8'
    );
    assert(
      app1Log.includes('-> cancelled'),
      'invocation not in cancelled state'
    );
    if (process.env.SIG_DEMO_FRAMES_DIR) {
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
    stopFrames();
  });

  // A5: with the mesh unreachable an @sig question is never posted; a bare
  // @sig is never posted either (A2); ordinary chat still works.
  it(DOWN_TEST, async () => {
    const pre1 = await app1.waitForSigMeshPreflight();
    assert(!pre1.ok, `expected preflight failure: ${JSON.stringify(pre1)}`);

    const window1 = await app1.getWindow();
    const window2 = await app2.getWindow();
    await window1
      .locator('#LeftPane')
      .locator(`[data-testid="${group.id}"]`)
      .click();
    await window2
      .locator('#LeftPane')
      .locator(`[data-testid="${group.id}"]`)
      .click();

    const question = '@sig Is anybody out there?';
    const composer1 = await waitForEnabledComposer(window1);
    await typeIntoInput(composer1, question, '');
    await composer1.press('Enter');
    await window1
      .locator('.Toast')
      .filter({ hasText: "Sig can't reach the mesh right now" })
      .waitFor();
    // Draft retained.
    await window1
      .locator('[data-testid=CompositionInput]')
      .filter({ hasText: question })
      .waitFor();

    await (await waitForEnabledComposer(window1)).fill('@sig');
    await (await waitForEnabledComposer(window1)).press('Enter');
    await window1
      .locator('.Toast')
      .filter({ hasText: 'Sig needs a question' })
      .waitFor();

    const plain = 'plain chat still works';
    await (await waitForEnabledComposer(window1)).fill(plain);
    await (await waitForEnabledComposer(window1)).press('Enter');
    await window2.locator(`.module-message__text >> "${plain}"`).waitFor();

    assert.strictEqual(
      await window2
        .locator('.module-message')
        .filter({ hasText: '@sig' })
        .count(),
      0
    );
  });
});
