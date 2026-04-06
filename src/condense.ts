const MAX_OUTPUT_LENGTH = 500;

export function condenseContent(content: string): string {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return '';

  const condensed: string[] = [];

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const out: Record<string, unknown> = {
      role: entry.role,
      ts: entry.ts || new Date().toISOString(),
    };

    if (entry.content !== undefined) out.content = entry.content;
    if (entry.tool !== undefined) out.tool = entry.tool;
    if (entry.input !== undefined) out.input = entry.input;
    if (entry.error !== undefined) out.error = entry.error;

    if (entry.output !== undefined) {
      const original = String(entry.output);
      out.output_chars = original.length;
      out.output_preview =
        original.length > MAX_OUTPUT_LENGTH
          ? original.slice(0, MAX_OUTPUT_LENGTH)
          : original;
    }

    condensed.push(JSON.stringify(out));
  }

  return condensed.join('\n');
}
