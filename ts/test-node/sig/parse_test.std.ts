// Copyright 2026 Michael Neale
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { parseSigInvocation } from '../../sig/parse.std.ts';

// Vectors from PLANS/SIG_PHASE1_INVOCATION_CONTRACT.md §2.3. The two structural
// vectors (mention range, 1:1) are gated outside the parser and are covered by
// the mock harness instead.
describe('sig/parse', () => {
  it('recognizes a leading @sig with a prompt', () => {
    assert.deepStrictEqual(parseSigInvocation('@sig what is 2+2'), {
      kind: 'recognized',
      prompt: 'what is 2+2',
      originalText: '@sig what is 2+2',
    });
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    const result = parseSigInvocation('  @Sig   summarise the options  ');
    assert.strictEqual(result.kind, 'recognized');
    if (result.kind === 'recognized') {
      assert.strictEqual(result.prompt, 'summarise the options');
    }
  });

  it('declines a bare @sig', () => {
    assert.deepStrictEqual(parseSigInvocation('@sig'), {
      kind: 'decline',
      reason: 'empty_prompt',
    });
    assert.deepStrictEqual(parseSigInvocation('@sig    '), {
      kind: 'decline',
      reason: 'empty_prompt',
    });
  });

  it('declines @sig that is not at the beginning', () => {
    assert.deepStrictEqual(parseSigInvocation('hello @sig'), {
      kind: 'decline',
      reason: 'not_sig',
    });
  });

  it('declines when @sig is a prefix of another word', () => {
    assert.deepStrictEqual(parseSigInvocation('@sigh that was close'), {
      kind: 'decline',
      reason: 'not_sig',
    });
    assert.deepStrictEqual(parseSigInvocation('@signal is great'), {
      kind: 'decline',
      reason: 'not_sig',
    });
  });

  it('unescapes \\@sig and declines', () => {
    assert.deepStrictEqual(parseSigInvocation('\\@sig is the trigger word'), {
      kind: 'decline',
      reason: 'escaped',
      text: '@sig is the trigger word',
    });
  });

  it('accepts a newline after the token and keeps inner newlines', () => {
    const result = parseSigInvocation('@sig\nmultiline\nprompt');
    assert.strictEqual(result.kind, 'recognized');
    if (result.kind === 'recognized') {
      assert.strictEqual(result.prompt, 'multiline\nprompt');
    }
  });

  it('declines prompts over 4,000 characters', () => {
    assert.deepStrictEqual(parseSigInvocation(`@sig ${'x'.repeat(4001)}`), {
      kind: 'decline',
      reason: 'too_long',
    });
    assert.strictEqual(
      parseSigInvocation(`@sig ${'x'.repeat(4000)}`).kind,
      'recognized'
    );
  });

  it('declines ordinary text', () => {
    assert.deepStrictEqual(parseSigInvocation('just a normal message'), {
      kind: 'decline',
      reason: 'not_sig',
    });
    assert.deepStrictEqual(parseSigInvocation(''), {
      kind: 'decline',
      reason: 'not_sig',
    });
  });
});
