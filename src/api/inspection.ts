import {
  BuiltInPowerupCodes,
  RemType,
  type PluginRem,
  type ReactRNPlugin,
  type PluginCardType,
  type RepetitionStatusInterface,
} from '@remnote/plugin-sdk';
import { contentHash } from './content-hash';
import { hasCardStructure } from './card-structure';
import { plainText } from './plain-text';
export interface InspectManyParams {
  schemaVersion: 1;
  remIds?: string[];
  subtreeRootIds?: string[];
  tagRemIds?: string[];
  maxRems?: number;
  ancestorDepth?: number;
}
export interface InspectionCheck {
  kind: string;
  remId: string;
  status: 'passed' | 'failed' | 'incomplete';
  actual?: unknown;
  expected?: unknown;
  message?: string;
}
export interface InspectionObject {
  remId: string;
  contentIncluded: boolean;
  textHash: string;
  title?: string;
  text?: unknown;
  backText?: unknown;
  aliases?: string[];
  parentRemId?: string;
  childrenRemIds: string[];
  ancestorRemIds: string[];
  remType: string;
  isFolder: boolean;
  isDocument: boolean;
  isCardItem: boolean;
  hasCardStructure: boolean;
  tags: string[];
  references: string[];
  powerups: { cc: boolean; u: boolean };
  taggedRemIds?: string[];
  cards: Array<{
    cardId: string;
    remId: string;
    type: PluginCardType;
    createdAt: number;
    repetitionHistory: RepetitionStatusInterface[];
    lastRepetitionTime?: number;
    nextRepetitionTime?: number;
    timesWrongInRow?: number;
  }>;
}
export interface InspectionResult {
  schemaVersion: 1;
  requestId: string;
  readWindow: { startedAt: string; finishedAt: string };
  complete: boolean;
  truncation: null | { reason: string; remainingRemIds: string[] };
  objects: InspectionObject[];
  scopes: Array<{ rootRemId: string; remIds: string[]; complete: boolean }>;
  checks: InspectionCheck[];
  errors: Array<{ remId?: string; code: string; message: string }>;
}
export type ScopeExpectation =
  | { kind: 'parent' | 'remType' | 'ancestor'; remId: string; value: string }
  | { kind: 'tag'; remId: string; value: string; present?: boolean; inverse?: boolean }
  | { kind: 'powerup'; remId: string; code: 'cc' | 'u'; value: boolean }
  | { kind: 'children' | 'references'; remId: string; value: string[]; exact?: boolean }
  | { kind: 'cardRemIds'; remId: string; value: string[] }
  | { kind: 'zeroCards'; remId: string; noCardStructure?: boolean };
export interface VerifyScopeParams {
  schemaVersion: 1;
  inspect: InspectManyParams;
  expectations: ScopeExpectation[];
}
function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
}
function only(value: object, fields: string[]): void {
  if (Object.keys(value).some((k) => !fields.includes(k)))
    throw new Error('Unknown inspection field');
}
function validId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error('Invalid Rem ID');
}
function ids(value: unknown, max: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid Rem ID list');
  value.forEach(validId);
}
export function validateInspectParams(p: InspectManyParams): void {
  assertObject(p);
  only(p, ['schemaVersion', 'remIds', 'subtreeRootIds', 'tagRemIds', 'maxRems', 'ancestorDepth']);
  if (p.schemaVersion !== 1) throw new Error('schemaVersion must equal 1');
  for (const [key, max] of [
    ['remIds', 100],
    ['subtreeRootIds', 10],
    ['tagRemIds', 10],
  ] as const)
    if (p[key] !== undefined) ids(p[key], max);
  if (!(p.remIds?.length || p.subtreeRootIds?.length || p.tagRemIds?.length))
    throw new Error('At least one selector required');
  for (const [key, min, max] of [
    ['maxRems', 1, 1000],
    ['ancestorDepth', 0, 20],
  ] as const)
    if (p[key] !== undefined && (!Number.isInteger(p[key]) || p[key]! < min || p[key]! > max))
      throw new Error(`Invalid ${key}`);
}
export function validateVerifyParams(p: VerifyScopeParams): void {
  assertObject(p);
  only(p, ['schemaVersion', 'inspect', 'expectations']);
  if (p.schemaVersion !== 1) throw new Error('schemaVersion must equal 1');
  validateInspectParams(p.inspect);
  if (!Array.isArray(p.expectations) || p.expectations.length < 1 || p.expectations.length > 200)
    throw new Error('Expected 1 through 200 checks');
  for (const c of p.expectations) {
    assertObject(c);
    validId(c.remId);
    const fields = ['kind', 'remId'];
    switch (c.kind) {
      case 'parent':
      case 'ancestor':
      case 'remType':
        validId(c.value);
        fields.push('value');
        break;
      case 'tag':
        validId(c.value);
        fields.push('value', 'present', 'inverse');
        for (const key of ['present', 'inverse'] as const)
          if (c[key] !== undefined && typeof c[key] !== 'boolean')
            throw new Error('Invalid tag check');
        break;
      case 'powerup':
        if (!['cc', 'u'].includes(c.code) || typeof c.value !== 'boolean')
          throw new Error('Invalid powerup check');
        fields.push('code', 'value');
        break;
      case 'children':
      case 'references':
        ids(c.value, 1000);
        if (c.exact !== undefined && typeof c.exact !== 'boolean') throw new Error('Invalid exact');
        fields.push('value', 'exact');
        break;
      case 'cardRemIds':
        ids(c.value, 1000);
        fields.push('value');
        break;
      case 'zeroCards':
        if (c.noCardStructure !== undefined && typeof c.noCardStructure !== 'boolean')
          throw new Error('Invalid noCardStructure');
        fields.push('noCardStructure');
        break;
      default:
        throw new Error('Unknown expectation kind');
    }
    only(c, fields);
  }
}
function remIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('SDK did not return Rem array');
  return value.map((v) => {
    if (!v || typeof v !== 'object' || typeof v._id !== 'string' || !v._id)
      throw new Error('SDK returned malformed Rem');
    return v._id;
  });
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('SDK did not return boolean');
  return value;
}
/** Internal request-local evidence, never cached or serialized as public context. */
export async function inspectWithEvidence(
  plugin: ReactRNPlugin,
  p: InspectManyParams
): Promise<{ result: InspectionResult; ancestorTails: Map<string, string> }> {
  validateInspectParams(p);
  const startedAt = new Date().toISOString();
  const result: InspectionResult = {
    schemaVersion: 1,
    requestId: crypto.randomUUID(),
    readWindow: { startedAt, finishedAt: startedAt },
    complete: true,
    truncation: null,
    objects: [],
    scopes: [],
    checks: [],
    errors: [],
  };
  const ancestorTails = new Map<string, string>();
  const max = p.maxRems ?? 1000,
    cache = new Map<string, PluginRem>(),
    failed = new Set<string>(),
    charged = new Set<string>(),
    children = new Map<string, string[]>(),
    wanted = new Set<string>();
  const explicit = new Set(p.remIds ?? []),
    tagIds = new Set(p.tagRemIds ?? []),
    inverse = new Map<string, string[]>();
  const error = (remId: string | undefined, code: string, message: string) => {
    result.complete = false;
    result.errors.push({ ...(remId ? { remId } : {}), code, message });
  };
  const truncate = (id: string, reason: string) => {
    result.complete = false;
    result.truncation ??= { reason, remainingRemIds: [] };
    if (!result.truncation.remainingRemIds.includes(id)) result.truncation.remainingRemIds.push(id);
  };
  const charge = (id: string) => {
    if (charged.has(id)) return true;
    if (charged.size >= max) {
      truncate(id, 'maxRems');
      return false;
    }
    charged.add(id);
    return true;
  };
  const get = async (id: string): Promise<PluginRem | undefined> => {
    if (cache.has(id)) return cache.get(id);
    if (failed.has(id) || !charge(id)) return;
    try {
      const rem = await plugin.rem.findOne(id);
      if (!rem || rem._id !== id) throw new Error('Rem missing or inaccessible');
      cache.set(id, rem);
      return rem;
    } catch (e) {
      failed.add(id);
      error(id, 'read_failed', String(e));
      return;
    }
  };
  const initial = [
    ...new Set([...(p.remIds ?? []), ...(p.subtreeRootIds ?? []), ...(p.tagRemIds ?? [])]),
  ];
  const batched = initial.filter(charge);
  if (batched.length)
    try {
      const found = await plugin.rem.findMany(batched);
      remIds(found);
      for (const rem of found ?? [])
        if (batched.includes(rem._id)) cache.set(rem._id, rem as PluginRem);
      for (const id of batched)
        if (!cache.has(id)) {
          failed.add(id);
          error(id, 'missing_rem', 'Rem missing from exact batch lookup');
        }
    } catch (e) {
      for (const id of batched) failed.add(id);
      error(undefined, 'batch_read_failed', String(e));
    }
  const childIds = async (rem: PluginRem): Promise<string[] | undefined> => {
    if (children.has(rem._id)) return children.get(rem._id);
    try {
      const list = await rem.getChildrenRem(),
        out = remIds(list);
      if (new Set(out).size !== out.length) throw new Error('Duplicate entity children');
      const declared = (rem as PluginRem & { children?: string[] }).children;
      if (
        Array.isArray(declared) &&
        declared.every((id) => typeof id === 'string') &&
        JSON.stringify(declared) !== JSON.stringify(out)
      )
        throw new Error('SDK omitted declared entity children');
      children.set(rem._id, out);
      return out;
    } catch (e) {
      error(rem._id, 'children_failed', String(e));
      return;
    }
  };
  initial.forEach((id) => wanted.add(id));
  for (const tagId of tagIds) {
    const rem = await get(tagId);
    if (!rem) continue;
    try {
      const list = remIds(await rem.taggedRem());
      inverse.set(tagId, list);
      for (const id of list) {
        wanted.add(id);
        await get(id);
      }
    } catch (e) {
      error(tagId, 'inverse_tag_failed', String(e));
    }
  }
  for (const rootId of [...new Set(p.subtreeRootIds ?? [])]) {
    const scope = { rootRemId: rootId, remIds: [] as string[], complete: true },
      seen = new Set<string>();
    result.scopes.push(scope);
    const queue = [rootId];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (seen.has(id)) {
        scope.complete = false;
        error(id, 'entity_cycle', 'Repeated child edge');
        continue;
      }
      seen.add(id);
      wanted.add(id);
      const rem = await get(id);
      if (!rem) {
        scope.complete = false;
        continue;
      }
      scope.remIds.push(id);
      const list = await childIds(rem);
      if (!list) {
        scope.complete = false;
        continue;
      }
      queue.push(...list);
      if (queue.length > max * 2) {
        scope.complete = false;
        truncate(id, 'entityScopeBudget');
        break;
      }
    }
  }
  for (const id of wanted) {
    const rem = await get(id);
    if (!rem) continue;
    try {
      const [folder, doc, cardItem, daily, tags, refs, cards, cc, u, parent, list] =
        await Promise.all([
          rem.isFolder(),
          rem.isDocument(),
          rem.isCardItem(),
          rem.hasPowerup(BuiltInPowerupCodes.DailyDocument),
          rem.getTagRems(),
          rem.remsBeingReferenced(),
          rem.getCards(),
          rem.hasPowerup('cc'),
          rem.hasPowerup('u'),
          rem.getParentRem(),
          childIds(rem),
        ]);
      if (!list) continue;
      [folder, doc, cardItem, daily, cc, u].forEach(flag);
      if (!Array.isArray(cards)) throw new Error('SDK cards malformed');
      const ancestors: string[] = [],
        seen = new Set([id]);
      let cursor = parent;
      for (let depth = 0; cursor && depth < (p.ancestorDepth ?? 20); depth++) {
        if (seen.has(cursor._id)) throw new Error('Ancestor cycle');
        seen.add(cursor._id);
        const existing = await get(cursor._id);
        if (!existing) throw new Error('Incomplete ancestor');
        ancestors.push(existing._id);
        cursor = await existing.getParentRem();
      }
      if (cursor) ancestorTails.set(id, cursor._id);
      const o: InspectionObject = {
        remId: id,
        contentIncluded: explicit.has(id),
        textHash: await contentHash(rem.text),
        ...(parent ? { parentRemId: parent._id } : {}),
        childrenRemIds: list,
        ancestorRemIds: ancestors,
        remType: daily
          ? 'dailyDocument'
          : folder
            ? 'folder'
            : doc
              ? 'document'
              : rem.type === RemType.CONCEPT
                ? 'concept'
                : rem.type === RemType.DESCRIPTOR
                  ? 'descriptor'
                  : rem.type === RemType.PORTAL
                    ? 'portal'
                    : 'text',
        isFolder: folder,
        isDocument: doc,
        isCardItem: cardItem,
        hasCardStructure: hasCardStructure(rem.text, rem.backText, cardItem),
        tags: remIds(tags),
        references: remIds(refs),
        powerups: { cc, u },
        cards: cards.map((c) => ({
          cardId: c._id,
          remId: c.remId,
          type: c.type,
          createdAt: c.createdAt,
          repetitionHistory: c.repetitionHistory ?? [],
          ...(c.lastRepetitionTime === undefined
            ? {}
            : { lastRepetitionTime: c.lastRepetitionTime }),
          ...(c.nextRepetitionTime === undefined
            ? {}
            : { nextRepetitionTime: c.nextRepetitionTime }),
          ...(c.timesWrongInRow === undefined ? {} : { timesWrongInRow: c.timesWrongInRow }),
        })),
      };
      if (explicit.has(id)) {
        o.text = rem.text ?? null;
        o.title = await plainText(plugin, rem.text);
        o.aliases = await Promise.all(
          (await rem.getAliases()).map((a) => plainText(plugin, a.text))
        );
        if (rem.backText !== undefined) o.backText = rem.backText;
      }
      if (inverse.has(id)) o.taggedRemIds = inverse.get(id);
      if (new TextEncoder().encode(JSON.stringify([...result.objects, o])).length > 1000000) {
        truncate(id, 'maxOutputBytes');
        continue;
      }
      result.objects.push(o);
    } catch (e) {
      error(id, 'inspection_failed', String(e));
    }
  }
  const present = new Set(result.objects.map((o) => o.remId));
  for (const scope of result.scopes)
    if (scope.remIds.some((id) => !present.has(id))) scope.complete = false;
  if (result.scopes.some((s) => !s.complete)) result.complete = false;
  result.readWindow.finishedAt = new Date().toISOString();
  return { result, ancestorTails };
}
export async function inspectMany(
  plugin: ReactRNPlugin,
  p: InspectManyParams
): Promise<InspectionResult> {
  return (await inspectWithEvidence(plugin, p)).result;
}
const equalSet = (a: string[], b: string[]) =>
  new Set(a).size === new Set(b).size && b.every((id) => a.includes(id));
export function verifyInspection(
  result: InspectionResult,
  p: VerifyScopeParams,
  ancestorTails: ReadonlyMap<string, string>
): InspectionResult & { status: 'passed' | 'failed' | 'incomplete' } {
  const objects = new Map(result.objects.map((o) => [o.remId, o]));
  const readComplete = result.complete;
  let failed = false,
    incomplete = !result.complete;
  for (const c of p.expectations) {
    const check: InspectionCheck = { kind: c.kind, remId: c.remId, status: 'incomplete' },
      o = objects.get(c.remId);
    result.checks.push(check);
    if (!o || !readComplete) {
      check.message = 'Required read evidence is incomplete';
      incomplete = true;
      continue;
    }
    let pass = false;
    switch (c.kind) {
      case 'parent':
        check.actual = o.parentRemId;
        check.expected = c.value;
        pass = o.parentRemId === c.value;
        break;
      case 'remType':
        check.actual = o.remType;
        check.expected = c.value;
        pass = o.remType === c.value;
        break;
      case 'ancestor': {
        check.actual = o.ancestorRemIds;
        check.expected = c.value;
        pass = o.ancestorRemIds.includes(c.value);
        const tail = ancestorTails.get(c.remId);
        if (!pass && tail) {
          incomplete = true;
          result.complete = false;
          result.truncation ??= { reason: 'ancestorDepth', remainingRemIds: [] };
          if (!result.truncation.remainingRemIds.includes(tail))
            result.truncation.remainingRemIds.push(tail);
          check.message =
            'Expected ancestor is outside the observed prefix; the remaining chain was not read';
          continue;
        }
        break;
      }
      case 'powerup':
        check.actual = o.powerups[c.code];
        check.expected = c.value;
        pass = check.actual === c.value;
        break;
      case 'tag': {
        const forward = o.tags.includes(c.value),
          tag = objects.get(c.value);
        if (
          c.inverse !== false &&
          (!(p.inspect.tagRemIds ?? []).includes(c.value) || !tag?.taggedRemIds)
        ) {
          incomplete = true;
          check.message = 'Independent inverse tag evidence required';
          continue;
        }
        const inverse = tag?.taggedRemIds?.includes(o.remId);
        check.expected = { tagRemId: c.value, present: c.present !== false };
        check.actual = { forward, ...(inverse === undefined ? {} : { inverse }) };
        pass =
          forward === (c.present !== false) &&
          (c.inverse === false || inverse === (c.present !== false));
        break;
      }
      case 'children': {
        check.actual = o.childrenRemIds;
        check.expected = c.value;
        let i = 0;
        pass =
          c.exact === false
            ? c.value.every((id) => {
                i = o.childrenRemIds.indexOf(id, i) + 1;
                return i > 0;
              })
            : JSON.stringify(c.value) === JSON.stringify(o.childrenRemIds);
        break;
      }
      case 'references':
        check.actual = o.references;
        check.expected = c.value;
        pass =
          c.exact === false
            ? c.value.every((id) => o.references.includes(id))
            : equalSet(o.references, c.value);
        break;
      case 'cardRemIds':
      case 'zeroCards': {
        const scope = result.scopes.find((s) => s.rootRemId === c.remId);
        if (!scope?.complete) {
          incomplete = true;
          check.message = 'Explicit complete subtree required';
          continue;
        }
        const members = scope.remIds.map((id) => objects.get(id));
        if (members.some((m) => !m)) {
          incomplete = true;
          continue;
        }
        const active = members.filter((m) => m!.cards.length).map((m) => m!.remId),
          structure = members.filter((m) => m!.hasCardStructure).map((m) => m!.remId);
        check.actual = { cardRemIds: active, cardStructureRemIds: structure };
        check.expected =
          c.kind === 'zeroCards'
            ? { cardRemIds: [], noCardStructure: c.noCardStructure !== false }
            : c.value;
        pass =
          c.kind === 'cardRemIds'
            ? equalSet(active, c.value)
            : active.length === 0 && (c.noCardStructure === false || structure.length === 0);
        break;
      }
    }
    check.status = pass ? 'passed' : 'failed';
    if (!pass) failed = true;
  }
  return { ...result, status: incomplete ? 'incomplete' : failed ? 'failed' : 'passed' };
}
export async function verifyScope(
  plugin: ReactRNPlugin,
  p: VerifyScopeParams
): Promise<InspectionResult & { status: 'passed' | 'failed' | 'incomplete' }> {
  validateVerifyParams(p);
  const { result, ancestorTails } = await inspectWithEvidence(plugin, p.inspect);
  return verifyInspection(result, p, ancestorTails);
}
