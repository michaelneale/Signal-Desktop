// Copyright 2026 Michael Neale
// SPDX-License-Identifier: AGPL-3.0-only

// Pure recognition of a `@sig <prompt>` composer submission. Platform-neutral;
// see PLANS/SIG_PHASE1_INVOCATION_CONTRACT.md §2 for the grammar and vectors.

export const SIG_MAX_PROMPT_LENGTH = 4000;

export type SigParseResult =
  | { kind: 'decline'; reason: 'not_sig' }
  | { kind: 'decline'; reason: 'empty_prompt' }
  | { kind: 'decline'; reason: 'too_long' }
  | { kind: 'decline'; reason: 'escaped'; text: string }
  | { kind: 'recognized'; prompt: string; originalText: string };

const TOKEN = /^\s*@sig(?=\s|$)/iu;
const ESCAPE = /^\s*\\@sig(?=\s|$)/iu;

export function parseSigInvocation(text: string): SigParseResult {
  if (ESCAPE.test(text)) {
    return {
      kind: 'decline',
      reason: 'escaped',
      text: text.replace('\\@', '@'),
    };
  }

  const match = TOKEN.exec(text);
  if (!match) {
    return { kind: 'decline', reason: 'not_sig' };
  }

  const prompt = text.slice(match[0].length).trim();
  if (prompt.length === 0) {
    return { kind: 'decline', reason: 'empty_prompt' };
  }
  if (prompt.length > SIG_MAX_PROMPT_LENGTH) {
    return { kind: 'decline', reason: 'too_long' };
  }

  return { kind: 'recognized', prompt, originalText: text };
}
