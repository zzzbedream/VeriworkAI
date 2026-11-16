/** Replaces `{name}` placeholders; unknown placeholders are left as they are. */
export function interpolate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * The text before and after `{name}`, so a link or other element can be rendered in its place.
 * Without the placeholder the whole template comes first.
 */
export function splitAround(template: string, name: string): readonly [string, string] {
  const marker = `{${name}}`;
  const index = template.indexOf(marker);
  return index === -1 ? [template, ''] : [template.slice(0, index), template.slice(index + marker.length)];
}

/** Placeholder names used by a template, sorted (for dictionary parity checks). */
export function placeholdersOf(template: string): readonly string[] {
  return Array.from(template.matchAll(/\{([A-Za-z0-9_]+)\}/g), (match) => match[1] ?? '').sort();
}
