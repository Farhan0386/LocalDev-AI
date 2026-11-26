/**
 * Applies a unified diff patch to original file content.
 * Returns the modified string if the patch applied cleanly, or undefined if the hunk failed to match.
 */
export function applyUnifiedDiff(patch: string, original: string): string | undefined {
  const content = patch
    .replace(/^```(?:diff|patch)?\s*/i, '')
    .replace(/\s*```[\s\S]*$/i, '')
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith('diff --git ')
        && !line.startsWith('index ')
        && !line.startsWith('--- ')
        && !line.startsWith('+++ '),
    );
  const source = original.split(/\r?\n/);
  const result: string[] = [];
  let sourceIndex = 0;
  let hunkFound = false;

  for (let index = 0; index < content.length; index += 1) {
    const hunk = content[index].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!hunk) continue;
    hunkFound = true;
    const start = Number(hunk[1]) - 1;
    if (start < sourceIndex || start > source.length) return undefined;
    result.push(...source.slice(sourceIndex, start));
    sourceIndex = start;
    for (index += 1; index < content.length && !content[index].startsWith('@@ '); index += 1) {
      const line = content[index];
      if (line === '\\ No newline at end of file') continue;
      if (line.startsWith(' ')) {
        if (source[sourceIndex] !== line.slice(1)) return undefined;
        result.push(source[sourceIndex]);
        sourceIndex += 1;
      } else if (line.startsWith('-')) {
        if (source[sourceIndex] !== line.slice(1)) return undefined;
        sourceIndex += 1;
      } else if (line.startsWith('+')) {
        result.push(line.slice(1));
      } else {
        return undefined;
      }
    }
    index -= 1;
  }

  if (!hunkFound) return undefined;
  result.push(...source.slice(sourceIndex));
  return result.join('\n');
}
