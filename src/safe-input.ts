export const SAFE_CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{4,128}$/;
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export function assertSafeJson(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > 32) throw new Error('JSON nesting exceeds limit');
    if (!item.value || typeof item.value !== 'object') continue;
    for (const [key, value] of Object.entries(item.value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error('Invalid JSON property');
      }
      pending.push({ value, depth: item.depth + 1 });
    }
  }
}

export function parseSafeJson(text: string): unknown {
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error('JSON exceeds byte limit');
  const value: unknown = JSON.parse(text);
  assertSafeJson(value);
  return value;
}
