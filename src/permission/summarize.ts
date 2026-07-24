const SECRET_KEY = /(?:api[_-]?key|authorization|password|secret|token)/i;
const CONTENT_KEY = /^(?:content|patch|new_string|old_string)$/i;
const MAX_SUMMARY_CHARS = 500;

/** Produce a bounded, secret-aware input summary for prompts and audit. */
export function summarizePermissionInput(input: unknown): string {
  const redacted = redact(input, new WeakSet<object>());
  const text = JSON.stringify(redacted) ?? String(redacted);
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text;
}

function redact(value: unknown, seen: WeakSet<object>, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (CONTENT_KEY.test(key) && typeof value === 'string') return `[${key}: ${value.length} chars]`;
  if (typeof value !== 'object' || value === null) {
    if (key === 'command' && typeof value === 'string') return redactCommand(value);
    return value;
  }
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redact(entryValue, seen, entryKey),
    ]),
  );
}

function redactCommand(command: string): string {
  return command
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/(--?(?:api-?key|token|password|secret))\s+\S+/gi, '$1 [REDACTED]');
}
