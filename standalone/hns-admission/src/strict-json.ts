/** Detect duplicate object keys, including escaped aliases, before Schema decoding. */
export function strictJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const tokens =
    text.match(
      /"(?:\\.|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
    ) ?? [];
  let i = 0;
  function visit(depth: number): void {
    if (depth > 64) throw new Error("json_too_deep");
    const token = tokens[i++];
    if (token === "{") {
      const keys = new Set<string>();
      while (tokens[i] !== "}") {
        const key = JSON.parse(tokens[i++]) as string;
        if (keys.has(key)) throw new Error("duplicate_json_key");
        keys.add(key);
        i++;
        visit(depth + 1);
        if (tokens[i] === ",") i++;
      }
      i++;
    } else if (token === "[") {
      while (tokens[i] !== "]") {
        visit(depth + 1);
        if (tokens[i] === ",") i++;
      }
      i++;
    }
  }
  visit(0);
  return value;
}
