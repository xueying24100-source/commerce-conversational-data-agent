export type ClassValue = string | number | null | false | undefined | ClassValue[];

/** Minimal classnames merger — flattens/filters, no dedupe/conflict resolution needed here. */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      const nested = cn(...value);
      if (nested) out.push(nested);
      continue;
    }
    out.push(String(value));
  }
  return out.join(' ');
}
