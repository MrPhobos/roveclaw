import fs from 'fs';

const MAX_OUTPUT_LENGTH = 500;

export function condenseContent(jsonlContent) {
  const lines = jsonlContent.split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';
  const condensed = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const out = { role: entry.role, ts: entry.ts || new Date().toISOString() };
    if (entry.content !== undefined) out.content = entry.content;
    if (entry.tool !== undefined) out.tool = entry.tool;
    if (entry.input !== undefined) out.input = entry.input;
    if (entry.error !== undefined) out.error = entry.error;
    if (entry.output !== undefined) {
      out.output_chars = entry.output.length;
      out.output_preview = entry.output.length > MAX_OUTPUT_LENGTH
        ? entry.output.slice(0, MAX_OUTPUT_LENGTH)
        : entry.output;
    }
    condensed.push(JSON.stringify(out));
  }
  return condensed.join('\n');
}

export function condense(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  return condenseContent(content);
}
