/** Replaces `{name}` placeholders; unknown placeholders are left as they are. */
export function interpolate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/** Placeholder names used by a template, sorted (for dictionary parity checks). */
export function placeholdersOf(template: string): readonly string[] {
  return Array.from(template.matchAll(/\{([A-Za-z0-9_]+)\}/g), (match) => match[1] ?? '').sort();
}
