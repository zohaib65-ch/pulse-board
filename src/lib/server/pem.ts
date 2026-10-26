const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;

/**
 * Rebuilds PEM text from however it was stored in an environment variable:
 * real newlines, escaped "\n" sequences, CRLF, surrounding quotes, or newlines that were
 * flattened to spaces. Each block is re-wrapped at 64 columns. Text without any PEM block
 * is returned trimmed so validation can report it.
 */
export function normalizePem(raw: string): string {
  let text = raw.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1);
  }
  text = text.replace(/\\r\\n|\\n|\\r/g, "\n");

  const blocks: string[] = [];
  for (const match of text.matchAll(BLOCK)) {
    const label = match[1];
    const body = match[2].replace(/\s+/g, "");
    if (!body) continue;
    const lines = body.match(/.{1,64}/g) ?? [];
    blocks.push(`-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`);
  }
  return blocks.length > 0 ? `${blocks.join("\n")}\n` : text;
}

export function containsPemBlock(text: string, labels?: RegExp): boolean {
  for (const match of text.matchAll(BLOCK)) {
    if (!labels || labels.test(match[1])) return true;
  }
  return false;
}
