/** Lowercase ASCII slug: "Harbourfront CCL / NEL" -> "harbourfront-ccl-nel". */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/@/g, ' at ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Name comparison key: lowercase, punctuation-insensitive, collapses spaces. */
export function nameKey(s: string): string {
  return slugify(s).replace(/-/g, ' ');
}
