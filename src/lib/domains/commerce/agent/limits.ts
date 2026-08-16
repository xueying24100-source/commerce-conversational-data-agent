export const COMMERCE_MESSAGE_MIN_CHARS = 2;
export const COMMERCE_MESSAGE_MAX_CHARS = 2_000;

export function isValidCommerceMessage(value: string): boolean {
  const length = value.trim().length;
  return length >= COMMERCE_MESSAGE_MIN_CHARS && length <= COMMERCE_MESSAGE_MAX_CHARS;
}
