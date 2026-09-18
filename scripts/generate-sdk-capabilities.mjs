import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = join(root, 'node_modules/@remnote/plugin-sdk');
const namespaceRoot = join(sdkRoot, 'dist/name_spaces');
const outputPath = join(root, 'src/api/sdk-capabilities.generated.ts');
const forbiddenMethods = new Set(['_call', 'call', 'constructor', '__proto__']);
const namespaceClasses = [
  ['app', 'app.d.ts', 'AppNamespace'],
  ['editor', 'editor.d.ts', 'EditorNamespace'],
  ['event', 'event.d.ts', 'EventNamespace'],
  ['messaging', 'messaging.d.ts', 'MessagingNamespace'],
  ['focus', 'focus.d.ts', 'FocusNamespace'],
  ['date', 'date.d.ts', 'DateNamespace'],
  ['widget', 'widget.d.ts', 'WidgetNamespace'],
  ['window', 'window.d.ts', 'WindowNamespace'],
  ['powerup', 'powerup.d.ts', 'PowerupNamespace'],
  ['richText', 'rich_text.d.ts', 'RichTextNamespace'],
  ['rem', 'rem.d.ts', 'RemNamespace'],
  ['card', 'card.d.ts', 'CardNamespace'],
  ['storage', 'storage.d.ts', 'StorageNamespace'],
  ['settings', 'settings.d.ts', 'SettingsNamespace'],
  ['search', 'search.d.ts', 'SearchNamespace'],
  ['kb', 'knowledge_base.d.ts', 'KnowledgeBaseNamespace'],
  ['scheduler', 'scheduler.d.ts', 'SchedulerNamespace'],
  ['queue', 'queue.d.ts', 'QueueNamespace'],
  ['reader', 'reader.d.ts', 'ReaderNamespace'],
];
const namespaceNames = new Set(namespaceClasses.map(([namespace]) => namespace));

const unsupportedReasons = new Map([
  ['namespace:plugin.track', 'Callbacks cannot cross the JSON bridge.'],
  [
    'namespace:app.registerWidget',
    'Widget registration is plugin lifecycle code, not a one-shot JSON call.',
  ],
  [
    'namespace:app.unregisterWidget',
    'Widget registration state is owned by plugin lifecycle code.',
  ],
  ['namespace:app.registerCommand', 'Command callbacks cannot cross the JSON bridge.'],
  ['namespace:app.registerRemMenuItem', 'Menu callbacks cannot cross the JSON bridge.'],
  ['namespace:app.registerMenuItem', 'Menu callbacks cannot cross the JSON bridge.'],
  [
    'namespace:app.unregisterMenuItem',
    'Menu registration state is owned by plugin lifecycle code.',
  ],
  ['namespace:app.registerCallback', 'Callbacks cannot cross the JSON bridge.'],
  ['namespace:app.transaction', 'Transaction callbacks cannot cross the JSON bridge.'],
  ['namespace:event.addListener', 'Event listeners require a persistent callback.'],
  ['namespace:event.removeListener', 'Event listeners require a persistent callback.'],
  ['namespace:scheduler.registerCustomScheduler', 'Scheduler callbacks are plugin lifecycle code.'],
]);

const richTextBuilderMethods = new Set([
  'code',
  'image',
  'rem',
  'text',
  'audio',
  'latex',
  'video',
  'newline',
]);

for (const method of richTextBuilderMethods) {
  unsupportedReasons.set(
    `namespace:richText.${method}`,
    'This method returns a stateful RichTextBuilder; use richText.parseFromMarkdown or another one-shot method.'
  );
}

const destructiveCapabilities = new Set([
  'namespace:editor.cut',
  'namespace:editor.delete',
  'namespace:editor.deleteCharacters',
  'namespace:queue.rateCurrentCard',
  'namespace:queue.removeCurrentCardFromQueue',
  'rem:merge',
  'rem:mergeAndSetAlias',
  'rem:remove',
  'rem:removeFromPortal',
  'rem:removePowerup',
  'rem:removeSource',
  'rem:removeTag',
  'card:remove',
  'card:updateCardRepetitionStatus',
]);

function isInteractive(namespace, method) {
  return (
    namespace === 'editor' ||
    namespace === 'focus' ||
    namespace === 'window' ||
    (namespace === 'queue' && method !== 'getAverageTimePerCard') ||
    (namespace === 'reader' && method === 'addHighlight') ||
    (namespace === 'widget' && method !== 'getWidgetsAtLocation')
  );
}

const writeMethodPattern =
  /^(add|collapse|copy|create|getOrCreate|indent|insert|merge|move|open|outdent|parseAndInsert|register|release|remove|scroll|set|steal|toast|update)/;

function parseSource(filePath) {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function isHidden(member) {
  return ts.getJSDocTags(member).some((tag) => tag.tagName.text === 'hidden');
}

function isPrivate(member) {
  return member.modifiers?.some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword
  );
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function getSummary(member) {
  for (const doc of member.jsDoc ?? []) {
    if (typeof doc.comment === 'string' && doc.comment.trim()) {
      return normalizeWhitespace(doc.comment.split(/\n\s*\n|\*\*Example:\*\*|```/)[0]);
    }
  }
  return undefined;
}

function callableMembers(filePath, className, { staticOnly = false } = {}) {
  const source = parseSource(filePath);
  const declaration = source.statements.find(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === className
  );
  if (!declaration) throw new Error(`Class ${className} not found in ${filePath}`);

  const methods = new Map();
  for (const member of declaration.members) {
    if (isPrivate(member) || isHidden(member)) continue;
    const isStatic = member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
    );
    if (staticOnly && !isStatic) continue;
    if (!staticOnly && isStatic) continue;
    if (
      !ts.isMethodDeclaration(member) &&
      !ts.isPropertyDeclaration(member) &&
      !ts.isGetAccessorDeclaration(member)
    ) {
      continue;
    }

    const method = member.name?.getText(source);
    if (!method || forbiddenMethods.has(method) || method.startsWith('_')) continue;
    const isReadonlyProperty =
      ts.isPropertyDeclaration(member) &&
      member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
    const callable =
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      (ts.isPropertyDeclaration(member) && !isReadonlyProperty);
    if (!callable) continue;

    const signature = normalizeWhitespace(member.getText(source).replace(/;$/, ''));
    const current = methods.get(method) ?? { method, signatures: [], summary: undefined };
    current.signatures.push(signature);
    current.summary ??= getSummary(member);
    methods.set(method, current);
  }

  return [...methods.values()];
}

function modeFor(id, target, method, namespace) {
  if (destructiveCapabilities.has(id)) return 'destructive';
  if (namespace && isInteractive(namespace, method)) return 'interactive';
  if (target === 'query') return 'read';
  return writeMethodPattern.test(method) ? 'write' : 'read';
}

function toKebabCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function commandLocation(target, namespace, method) {
  if (target === 'rem') return { group: 'rem', command: `object-${toKebabCase(method)}` };
  if (target === 'card') return { group: 'card', command: `object-${toKebabCase(method)}` };
  if (target === 'query') return { group: 'search', command: `query-${toKebabCase(method)}` };
  if (namespace === 'richText.builder') {
    return { group: 'richText', command: `builder-${toKebabCase(method)}` };
  }
  if (namespace === 'plugin') return { group: 'app', command: `plugin-${toKebabCase(method)}` };
  if (!namespace || !namespaceNames.has(namespace)) {
    throw new Error(`Cannot place SDK capability ${target}:${namespace ?? ''}.${method}`);
  }
  return { group: namespace, command: toKebabCase(method) };
}

function capability({ id, target, namespace, method, signatures, summary, reason }) {
  const location = commandLocation(target, namespace, method);
  return {
    id,
    target,
    ...(namespace ? { namespace } : {}),
    method,
    ...location,
    signatures,
    ...(summary ? { summary } : {}),
    status: reason ? 'unsupported' : 'supported',
    mode: modeFor(id, target, method, namespace),
    ...(reason ? { reason } : {}),
  };
}

const capabilities = [];
for (const [namespace, fileName, className] of namespaceClasses) {
  for (const { method, signatures, summary } of callableMembers(
    join(namespaceRoot, fileName),
    className
  )) {
    const id = `namespace:${namespace}.${method}`;
    capabilities.push(
      capability({
        id,
        target: 'namespace',
        namespace,
        method,
        signatures,
        summary,
        reason: unsupportedReasons.get(id),
      })
    );
  }
}

for (const { method, signatures, summary } of callableMembers(
  join(namespaceRoot, 'rem.d.ts'),
  'RemObject'
)) {
  const id = `rem:${method}`;
  capabilities.push(
    capability({
      id,
      target: 'rem',
      method,
      signatures,
      summary,
      reason: unsupportedReasons.get(id),
    })
  );
}

for (const { method, signatures, summary } of callableMembers(
  join(namespaceRoot, 'card.d.ts'),
  'Card'
)) {
  const id = `card:${method}`;
  capabilities.push(
    capability({
      id,
      target: 'card',
      method,
      signatures,
      summary,
      reason: unsupportedReasons.get(id),
    })
  );
}

for (const { method, signatures, summary } of callableMembers(
  join(namespaceRoot, 'query.d.ts'),
  'Query_DUPE_2',
  { staticOnly: true }
)) {
  const id = `query:${method}`;
  capabilities.push(
    capability({
      id,
      target: 'query',
      method,
      signatures,
      summary,
      reason: unsupportedReasons.get(id),
    })
  );
}

for (const { method, signatures, summary } of callableMembers(
  join(namespaceRoot, 'rich_text.d.ts'),
  'RichTextBuilder'
)) {
  const id = `namespace:richText.builder.${method}`;
  capabilities.push(
    capability({
      id,
      target: 'namespace',
      namespace: 'richText.builder',
      method,
      signatures,
      summary,
      reason:
        'RichTextBuilder is stateful and the bridge does not expose in-memory object handles.',
    })
  );
}

const pluginTrack = callableMembers(join(sdkRoot, 'dist/plugin_base.d.ts'), 'RNPlugin').find(
  ({ method }) => method === 'track'
);
if (!pluginTrack) throw new Error('RNPlugin.track not found');
capabilities.push(
  capability({
    id: 'namespace:plugin.track',
    target: 'namespace',
    namespace: 'plugin',
    ...pluginTrack,
    reason: unsupportedReasons.get('namespace:plugin.track'),
  })
);

capabilities.sort((left, right) => left.id.localeCompare(right.id));

const commandKeys = capabilities.map(({ group, command }) => `${group}:${command}`);
if (new Set(commandKeys).size !== commandKeys.length) {
  throw new Error('SDK CLI command mapping contains duplicate group/command pairs');
}

if (namespaceClasses.length !== 19 || capabilities.length !== 286) {
  throw new Error(
    `SDK surface drifted: expected 19 namespaces and 286 capabilities, found ${namespaceClasses.length} and ${capabilities.length}`
  );
}

const sdkVersion = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).version;
const rawContent =
  `// Generated by scripts/generate-sdk-capabilities.mjs. Do not edit by hand.\n` +
  `export const REMNOTE_SDK_VERSION = ${JSON.stringify(sdkVersion)};\n\n` +
  `export const SDK_CAPABILITIES = ${JSON.stringify(capabilities, null, 2)} as const;\n`;
const content = await prettier.format(rawContent, {
  ...(await prettier.resolveConfig(outputPath)),
  parser: 'typescript',
});

if (process.argv.includes('--check')) {
  const current = readFileSync(outputPath, 'utf8');
  if (current !== content) {
    console.error(`${relative(root, outputPath)} is stale. Run npm run generate:sdk-capabilities.`);
    process.exit(1);
  }
} else {
  writeFileSync(outputPath, content);
  console.log(`Generated ${capabilities.length} SDK capabilities for ${sdkVersion}.`);
}
