import { Card, PluginRem, Query_DUPE_2, type ReactRNPlugin } from '@remnote/plugin-sdk';
import { REMNOTE_SDK_VERSION, SDK_CAPABILITIES } from './sdk-capabilities.generated';

export type SdkCapability = (typeof SDK_CAPABILITIES)[number];

export interface SdkCallParams {
  capability: string;
  targetId?: string;
  args?: unknown[];
  allowDestructive?: boolean;
}

export interface SdkCapabilitiesResult {
  sdkVersion: string;
  capabilities: SdkCapability[];
}

export interface SdkCallResult {
  capability: string;
  value: unknown;
}

const FORBIDDEN_METHODS = new Set(['_call', 'call', 'constructor', '__proto__']);
const MAX_DEPTH = 12;
const MAX_NODES = 10_000;
const MAX_COLLECTION_SIZE = 1_000;
const MAX_TEXT_SIZE = 1_000_000;

type JsonObject = Record<string, unknown>;

const capabilityById = new Map<string, SdkCapability>(
  SDK_CAPABILITIES.map((entry) => [entry.id, entry])
);

function isPlainObject(value: object): value is JsonObject {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertBound(
  value: unknown,
  depth: number,
  state: { nodes: number; textSize: number }
): void {
  if (depth > MAX_DEPTH) throw new Error(`SDK value exceeds maximum depth ${MAX_DEPTH}`);
  state.nodes += 1;
  if (state.nodes > MAX_NODES) throw new Error(`SDK value exceeds maximum node count ${MAX_NODES}`);
  if (typeof value === 'string') {
    state.textSize += value.length;
    if (state.textSize > MAX_TEXT_SIZE) {
      throw new Error(`SDK value exceeds maximum text size ${MAX_TEXT_SIZE}`);
    }
  }
}

function isRem(value: object): value is PluginRem {
  return (
    value instanceof PluginRem ||
    ('_id' in value &&
      typeof (value as { _id?: unknown })._id === 'string' &&
      'getChildrenRem' in value &&
      typeof (value as { getChildrenRem?: unknown }).getChildrenRem === 'function')
  );
}

function isCard(value: object): value is Card {
  return (
    value instanceof Card ||
    ('_id' in value &&
      typeof (value as { _id?: unknown })._id === 'string' &&
      'remId' in value &&
      typeof (value as { remId?: unknown }).remId === 'string' &&
      'getRem' in value &&
      typeof (value as { getRem?: unknown }).getRem === 'function')
  );
}

function definedEntries(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function sdkRemToObject(rem: PluginRem): JsonObject {
  return definedEntries({
    $type: 'rem',
    id: rem._id,
    createdAt: rem.createdAt,
    localUpdatedAt: rem.localUpdatedAt,
    updatedAt: rem.updatedAt,
    parent: rem.parent,
    children: rem.children,
    type: rem.type,
    text: rem.text,
    backText: rem.backText,
  });
}

function sdkCardToObject(card: Card): JsonObject {
  return definedEntries({
    $type: 'card',
    id: card._id,
    remId: card.remId,
    type: card.type,
    createdAt: card.createdAt,
    repetitionHistory: card.repetitionHistory,
    nextRepetitionTime: card.nextRepetitionTime,
    timesWrongInRow: card.timesWrongInRow,
    lastRepetitionTime: card.lastRepetitionTime,
  });
}

function domRectToObject(rect: DOMRectReadOnly): JsonObject {
  return {
    $type: 'domRect',
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

function serializeSdkValue(
  value: unknown,
  depth = 0,
  state = { nodes: 0, textSize: 0 },
  active = new WeakSet<object>()
): unknown {
  assertBound(value, depth, state);
  if (value === undefined) return { $type: 'undefined' };
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SDK value contains a non-finite number');
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`SDK value contains unsupported ${typeof value}`);
  }

  if (active.has(value)) throw new Error('SDK value contains a circular reference');
  active.add(value);
  try {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new Error('SDK value contains an invalid Date');
      return { $type: 'date', value: value.toISOString() };
    }
    if (isRem(value)) return serializeSdkValue(sdkRemToObject(value), depth + 1, state, active);
    if (isCard(value)) return serializeSdkValue(sdkCardToObject(value), depth + 1, state, active);
    if (
      typeof DOMRectReadOnly !== 'undefined' &&
      (value instanceof DOMRectReadOnly ||
        (typeof DOMRect !== 'undefined' && value instanceof DOMRect))
    ) {
      return serializeSdkValue(domRectToObject(value), depth + 1, state, active);
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_SIZE) {
        throw new Error(`SDK array exceeds maximum length ${MAX_COLLECTION_SIZE}`);
      }
      return value.map((entry) => serializeSdkValue(entry, depth + 1, state, active));
    }
    if (!isPlainObject(value)) {
      throw new Error(
        `SDK value contains unsupported class ${value.constructor?.name || 'unknown'}`
      );
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_COLLECTION_SIZE) {
      throw new Error(`SDK object exceeds maximum key count ${MAX_COLLECTION_SIZE}`);
    }
    return Object.fromEntries(
      entries.map(([key, entry]) => {
        assertBound(key, depth + 1, state);
        return [key, serializeSdkValue(entry, depth + 1, state, active)];
      })
    );
  } finally {
    active.delete(value);
  }
}

async function resolveSdkArgument(
  plugin: ReactRNPlugin,
  value: unknown,
  depth = 0,
  active = new WeakSet<object>()
): Promise<unknown> {
  if (depth > MAX_DEPTH) throw new Error(`SDK argument exceeds maximum depth ${MAX_DEPTH}`);
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SDK argument contains a non-finite number');
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`SDK argument contains unsupported ${typeof value}`);
  }
  if (active.has(value)) throw new Error('SDK argument contains a circular reference');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_SIZE) {
        throw new Error(`SDK argument array exceeds maximum length ${MAX_COLLECTION_SIZE}`);
      }
      return await Promise.all(
        value.map((entry) => resolveSdkArgument(plugin, entry, depth + 1, active))
      );
    }
    if (!isPlainObject(value)) {
      throw new Error(
        `SDK argument contains unsupported class ${value.constructor?.name || 'unknown'}`
      );
    }
    if ('$ref' in value) {
      const refType = value.$ref;
      const id = value.id;
      if ((refType !== 'rem' && refType !== 'card') || typeof id !== 'string' || !id) {
        throw new Error("SDK reference must be {$ref:'rem'|'card', id:string}");
      }
      const resolved =
        refType === 'rem' ? await plugin.rem.findOne(id) : await plugin.card.findOne(id);
      if (!resolved) throw new Error(`${refType === 'rem' ? 'Rem' : 'Card'} not found: ${id}`);
      return resolved;
    }
    if ('$type' in value) {
      if (value.$type !== 'date' || typeof value.value !== 'string') {
        throw new Error("SDK typed value must be {$type:'date', value:string}");
      }
      const date = new Date(value.value);
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid SDK date: ${value.value}`);
      return date;
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_COLLECTION_SIZE) {
      throw new Error(`SDK argument object exceeds maximum key count ${MAX_COLLECTION_SIZE}`);
    }
    return Object.fromEntries(
      await Promise.all(
        entries.map(async ([key, entry]) => [
          key,
          await resolveSdkArgument(plugin, entry, depth + 1, active),
        ])
      )
    );
  } finally {
    active.delete(value);
  }
}

export function getSdkCapabilities(): SdkCapabilitiesResult {
  return {
    sdkVersion: REMNOTE_SDK_VERSION,
    capabilities: SDK_CAPABILITIES.map((entry) => ({ ...entry })),
  };
}

export async function executeSdkCall(
  plugin: ReactRNPlugin,
  acceptWriteOperations: boolean,
  params: SdkCallParams
): Promise<SdkCallResult> {
  if (!acceptWriteOperations) {
    throw new Error(
      'SDK calls are disabled because write operations are disabled in Automation Bridge settings'
    );
  }
  if (!params || typeof params.capability !== 'string' || !params.capability) {
    throw new Error('sdk_call requires capability');
  }

  const capability = capabilityById.get(params.capability);
  if (!capability) throw new Error(`Unknown SDK capability: ${params.capability}`);
  if (FORBIDDEN_METHODS.has(capability.method)) {
    throw new Error(`Forbidden SDK method: ${capability.method}`);
  }
  if (capability.status === 'unsupported') {
    throw new Error(`Unsupported SDK capability ${capability.id}: ${capability.reason}`);
  }
  if (capability.mode === 'destructive' && params.allowDestructive !== true) {
    throw new Error(`SDK capability ${capability.id} requires allowDestructive=true`);
  }
  if (params.args !== undefined && !Array.isArray(params.args)) {
    throw new Error('sdk_call args must be an array');
  }

  let target: object;
  if (capability.target === 'rem') {
    if (typeof params.targetId !== 'string' || !params.targetId) {
      throw new Error(`SDK capability ${capability.id} requires targetId`);
    }
    const rem = await plugin.rem.findOne(params.targetId);
    if (!rem) throw new Error(`Rem not found: ${params.targetId}`);
    target = rem;
  } else if (capability.target === 'card') {
    if (typeof params.targetId !== 'string' || !params.targetId) {
      throw new Error(`SDK capability ${capability.id} requires targetId`);
    }
    const card = await plugin.card.findOne(params.targetId);
    if (!card) throw new Error(`Card not found: ${params.targetId}`);
    target = card;
  } else if (capability.target === 'query') {
    target = Query_DUPE_2;
  } else {
    const namespace = capability.namespace;
    if (!namespace || namespace.includes('.')) {
      throw new Error(`Unsupported SDK target for ${capability.id}`);
    }
    const resolved = Reflect.get(plugin, namespace);
    if (!resolved || (typeof resolved !== 'object' && typeof resolved !== 'function')) {
      throw new Error(`SDK namespace is unavailable: ${namespace}`);
    }
    target = resolved as object;
  }

  const method = Reflect.get(target, capability.method);
  if (typeof method !== 'function') {
    throw new Error(`SDK method is unavailable: ${capability.id}`);
  }
  const args = await resolveSdkArgument(plugin, params.args ?? []);
  const value = await Reflect.apply(method, target, args as unknown[]);
  return { capability: capability.id, value: serializeSdkValue(value) };
}
