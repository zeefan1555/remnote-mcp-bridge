import { describe, it, expect, vi } from 'vitest';
import { BuiltInPowerupCodes, RemType } from '@remnote/plugin-sdk';
import {
  inspectMany,
  verifyScope,
  validateInspectParams,
  validateVerifyParams,
} from '../../src/api/inspection';
import { contentHash } from '../../src/api/content-hash';
function fixture() {
  type R = ReturnType<typeof make>;
  const nodes = new Map<string, R>();
  function make(id: string, parent?: string) {
    const r = {
      _id: id,
      type: RemType.DEFAULT_TYPE,
      text: [id] as unknown[],
      backText: undefined as unknown,
      children: [] as string[],
      parent,
      getParentRem: vi.fn(async () => (r.parent ? nodes.get(r.parent) : undefined)),
      getChildrenRem: vi.fn(async () => r.children.map((id) => nodes.get(id)).filter(Boolean)),
      isFolder: vi.fn(async () => false),
      isDocument: vi.fn(async () => false),
      isCardItem: vi.fn(async () => false),
      hasPowerup: vi.fn(async (_code: string) => false),
      getTagRems: vi.fn(async () => [] as R[]),
      taggedRem: vi.fn(async () => [] as R[]),
      remsBeingReferenced: vi.fn(async () => [] as R[]),
      getCards: vi.fn(async () => [] as unknown[]),
      getAliases: vi.fn(async () => [] as R[]),
    };
    nodes.set(id, r);
    if (parent) nodes.get(parent)!.children.push(id);
    return r;
  }
  const plugin = {
    rem: {
      findOne: vi.fn(async (id: string) => nodes.get(id)),
      findMany: vi.fn(async (ids: string[]) => ids.map((id) => nodes.get(id)).filter(Boolean)),
    },
    date: {
      getTodaysDoc: vi.fn(() => {
        throw new Error('date forbidden');
      }),
    },
    storage: { getLocal: vi.fn(), setLocal: vi.fn() },
  };
  return { make, plugin, nodes };
}
describe('bounded inspection receipts', () => {
  it('reads exact IDs in one initial batch and projects descendant metadata without content', async () => {
    const { make, plugin } = fixture();
    make('root');
    make('child', 'root');
    const r = await inspectMany(plugin as never, {
      schemaVersion: 1,
      remIds: ['root'],
      subtreeRootIds: ['root'],
    });
    expect(r.complete).toBe(true);
    expect(plugin.rem.findMany).toHaveBeenCalledTimes(1);
    expect(r.objects.find((o) => o.remId === 'root')?.text).toEqual(['root']);
    const child = r.objects.find((o) => o.remId === 'child')!;
    expect(child.contentIncluded).toBe(false);
    for (const field of ['text', 'title', 'aliases', 'backText'])
      expect(child).not.toHaveProperty(field);
    expect(r.scopes[0]).toEqual({ rootRemId: 'root', remIds: ['root', 'child'], complete: true });
    expect(plugin.date.getTodaysDoc).not.toHaveBeenCalled();
    expect(plugin.storage.getLocal).not.toHaveBeenCalled();
    expect(plugin.storage.setLocal).not.toHaveBeenCalled();
  });
  it('serializes absent raw SDK text explicitly as null with matching hash', async () => {
    const { make, plugin } = fixture();
    make('empty').text = undefined as never;
    const r = await inspectMany(plugin as never, { schemaVersion: 1, remIds: ['empty'] });
    const object = JSON.parse(JSON.stringify(r)).objects[0];
    expect(object.text).toBeNull();
    expect(object.textHash).toBe(await contentHash(null));
    expect(r.complete).toBe(true);
  });
  it.each(['getTagRems', 'getAliases', 'isCardItem', 'getCards'] as const)(
    'propagates %s errors rather than proving empty state',
    async (method) => {
      const { make, plugin } = fixture();
      const r = make('r');
      r[method].mockRejectedValueOnce(new Error('read failed'));
      const out = await verifyScope(plugin as never, {
        schemaVersion: 1,
        inspect: { schemaVersion: 1, remIds: ['r'] },
        expectations: [{ kind: 'tag', remId: 'r', value: 'tag', present: false, inverse: false }],
      });
      expect(out.status).toBe('incomplete');
      expect(out.complete).toBe(false);
      expect(out.errors.length).toBeGreaterThan(0);
    }
  );
  it('keeps unnamed exact tags and requires independent inverse membership', async () => {
    const { make, plugin } = fixture();
    const r = make('r'),
      tag = make('tag');
    tag.text = [];
    r.getTagRems.mockResolvedValue([tag]);
    tag.taggedRem.mockResolvedValue([r]);
    const out = await verifyScope(plugin as never, {
      schemaVersion: 1,
      inspect: { schemaVersion: 1, remIds: ['r'], tagRemIds: ['tag'] },
      expectations: [{ kind: 'tag', remId: 'r', value: 'tag' }],
    });
    expect(out.status).toBe('passed');
    expect(out.objects.find((o) => o.remId === 'r')?.tags).toEqual(['tag']);
    const missing = await verifyScope(plugin as never, {
      schemaVersion: 1,
      inspect: { schemaVersion: 1, remIds: ['r', 'tag'] },
      expectations: [{ kind: 'tag', remId: 'r', value: 'tag' }],
    });
    expect(missing.status).toBe('incomplete');
  });
  it('does not accept malformed tags as absence', async () => {
    const { make, plugin } = fixture();
    make('r').getTagRems.mockResolvedValue([{}] as never);
    expect((await inspectMany(plugin as never, { schemaVersion: 1, remIds: ['r'] })).complete).toBe(
      false
    );
  });
  it('reports an omitted declared child incomplete', async () => {
    const { make, plugin } = fixture();
    make('root').children = ['missing'];
    const r = await verifyScope(plugin as never, {
      schemaVersion: 1,
      inspect: { schemaVersion: 1, subtreeRootIds: ['root'] },
      expectations: [{ kind: 'zeroCards', remId: 'root' }],
    });
    expect(r.status).toBe('incomplete');
    expect(r.scopes[0].complete).toBe(false);
  });
  it('reports missing batch objects incomplete', async () => {
    const { plugin } = fixture();
    const r = await inspectMany(plugin as never, { schemaVersion: 1, remIds: ['absent'] });
    expect(r.complete).toBe(false);
    expect(r.errors[0].code).toBe('missing_rem');
  });
  it('requires explicit complete subtree for zero-card proof', async () => {
    const { make, plugin } = fixture();
    make('r');
    const r = await verifyScope(plugin as never, {
      schemaVersion: 1,
      inspect: { schemaVersion: 1, remIds: ['r'] },
      expectations: [{ kind: 'zeroCards', remId: 'r' }],
    });
    expect(r.status).toBe('incomplete');
  });
  it('detects native disabled delimiter structure but not literal arrow text', async () => {
    const { make, plugin } = fixture();
    const r = make('r');
    r.text = ['Front', { i: 's' }, 'Back'];
    const params = {
      schemaVersion: 1 as const,
      inspect: { schemaVersion: 1 as const, subtreeRootIds: ['r'] },
      expectations: [{ kind: 'zeroCards' as const, remId: 'r' }],
    };
    expect((await verifyScope(plugin as never, params)).status).toBe('failed');
    r.text = ['A → B >> C ==='];
    expect((await verifyScope(plugin as never, params)).status).toBe('passed');
    r.backText = ['back'];
    expect((await verifyScope(plugin as never, params)).status).toBe('failed');
  });
  it('counts ancestor reads against the request-wide budget', async () => {
    const { make, plugin } = fixture();
    make('root');
    make('child', 'root');
    const out = await inspectMany(plugin as never, {
      schemaVersion: 1,
      remIds: ['child'],
      maxRems: 1,
    });
    expect(out.complete).toBe(false);
    expect(out.truncation?.reason).toBe('maxRems');
  });
  it('limits subtree scope and never certifies a truncated zero-card check', async () => {
    const { make, plugin } = fixture();
    make('root');
    make('child', 'root');
    const out = await verifyScope(plugin as never, {
      schemaVersion: 1,
      inspect: { schemaVersion: 1, subtreeRootIds: ['root'], maxRems: 1 },
      expectations: [{ kind: 'zeroCards', remId: 'root' }],
    });
    expect(out.status).toBe('incomplete');
    expect(out.scopes[0].complete).toBe(false);
  });
  it('bounds serialized content at one MB', async () => {
    const { make, plugin } = fixture();
    make('big').text = ['x'.repeat(1000001)];
    const out = await inspectMany(plugin as never, { schemaVersion: 1, remIds: ['big'] });
    expect(out.complete).toBe(false);
    expect(out.truncation?.reason).toBe('maxOutputBytes');
    expect(out.objects).toEqual([]);
  });
  it('checks order, references, native daily type and exact scoped card sets', async () => {
    const { make, plugin } = fixture();
    const root = make('daily'),
      a = make('a', 'daily'),
      b = make('b', 'daily');
    root.hasPowerup.mockImplementation(async (c) => c === BuiltInPowerupCodes.DailyDocument);
    a.getCards.mockResolvedValue([
      { _id: 'native-card', remId: 'a', type: 'forward', createdAt: 1 },
    ]);
    b.remsBeingReferenced.mockResolvedValue([a]);
    const out = await verifyScope(plugin as never, {
      schemaVersion: 1,
      inspect: { schemaVersion: 1, subtreeRootIds: ['daily'] },
      expectations: [
        { kind: 'remType', remId: 'daily', value: 'dailyDocument' },
        { kind: 'children', remId: 'daily', value: ['a', 'b'] },
        { kind: 'references', remId: 'b', value: ['a'] },
        { kind: 'cardRemIds', remId: 'daily', value: ['a'] },
      ],
    });
    expect(out.status).toBe('passed');
  });
  it('rejects invalid inputs without SDK calls', () => {
    expect(() => validateInspectParams({ schemaVersion: 1 })).toThrow();
    expect(() =>
      validateInspectParams({ schemaVersion: 1, remIds: ['r'], maxRems: 1001 })
    ).toThrow();
    expect(() =>
      validateVerifyParams({
        schemaVersion: 1,
        inspect: { schemaVersion: 1, remIds: ['r'] },
        expectations: [],
      })
    ).toThrow();
  });
});
