import type { RichTextInterface } from '@remnote/plugin-sdk';
export function cardDelimiterIndex(text: RichTextInterface | undefined): number {
  return Array.isArray(text)
    ? text.findIndex((p) => typeof p === 'object' && p !== null && 'i' in p && p.i === 's')
    : -1;
}
export function hasCardStructure(
  text: RichTextInterface | undefined,
  backText: RichTextInterface | undefined,
  cardItem: boolean
): boolean {
  return Boolean(backText?.length) || cardDelimiterIndex(text) >= 0 || cardItem;
}
