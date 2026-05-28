/**
 * Escape an arbitrary UTF-8 string into a TOML basic string literal.
 *
 * Used to embed paths inside inline-table CLI overrides (`-c k=v`) where the
 * value is a TOML inline-array literal containing string fields. JSON.stringify
 * is NOT a substitute: TOML basic-string escapes diverge from JSON in edge
 * cases (control chars, optional `\/`).
 *
 * Per TOML 1.0.0 §Strings, basic strings must escape:
 *   - `\` → `\\`
 *   - `"` → `\"`
 *   - `\b` `\f` `\n` `\r` `\t` (named escapes)
 *   - any other control char (U+0000..U+001F, U+007F) → `\uXXXX`
 */
export function escapeTomlBasicString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}
