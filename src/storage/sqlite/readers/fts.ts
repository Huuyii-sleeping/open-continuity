export function ftsPhrase(query: string): string {
  return `"${query.replaceAll('\"', '\"\"')}"`;
}
