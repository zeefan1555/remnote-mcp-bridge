import type { ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';

/** Names must use the SDK's supported rich-text renderer, never lossy string filtering. */
export async function plainText(
  plugin: ReactRNPlugin,
  text: RichTextInterface | undefined
): Promise<string> {
  const rendered = await plugin.richText.toString(text ?? []);
  if (typeof rendered !== 'string')
    throw new Error('SDK rich-text rendering did not return a string');
  return rendered;
}
