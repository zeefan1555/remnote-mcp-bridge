import { describe, expect, it, vi } from 'vitest';
import { executeSdkCall, getSdkCapabilities } from '../../src/api/sdk-executor';
import { MockRemNotePlugin } from '../helpers/mocks';

describe('SDK executor', () => {
  it('keeps the generated SDK 0.0.46 registry complete and current', () => {
    const result = getSdkCapabilities();

    expect(result.sdkVersion).toBe('0.0.46');
    expect(result.capabilities).toHaveLength(286);
    expect(result.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'namespace:powerup.getPowerupSlotByCode' }),
        expect.objectContaining({
          id: 'rem:getChildrenRem',
          group: 'rem',
          command: 'object-get-children-rem',
          signatures: expect.arrayContaining([expect.stringContaining('getChildrenRem')]),
          status: 'supported',
        }),
        expect.objectContaining({ id: 'card:getRem', status: 'supported' }),
        expect.objectContaining({
          id: 'card:updateCardRepetitionStatus',
          mode: 'destructive',
        }),
        expect.objectContaining({ id: 'query:text', status: 'supported' }),
        expect.objectContaining({
          id: 'namespace:focus.getFocusedRem',
          mode: 'interactive',
        }),
        expect.objectContaining({
          id: 'namespace:event.addListener',
          status: 'unsupported',
        }),
        expect.objectContaining({
          id: 'namespace:richText.builder.value',
          status: 'unsupported',
        }),
        expect.objectContaining({ id: 'namespace:plugin.track', status: 'unsupported' }),
      ])
    );
    expect(
      new Set(result.capabilities.map(({ group, command }) => `${group}:${command}`)).size
    ).toBe(result.capabilities.length);
  });

  it('requires the global write gate for every sdk_call', async () => {
    const plugin = new MockRemNotePlugin();

    await expect(
      executeSdkCall(plugin as never, false, {
        capability: 'namespace:date.getTodaysDoc',
      })
    ).rejects.toThrow('write operations are disabled');
  });

  it('rejects unsupported and unregistered methods', async () => {
    const plugin = new MockRemNotePlugin();

    await expect(
      executeSdkCall(plugin as never, true, {
        capability: 'namespace:event.addListener',
      })
    ).rejects.toThrow('Unsupported SDK capability');
    await expect(
      executeSdkCall(plugin as never, true, { capability: 'namespace:kb.call' })
    ).rejects.toThrow('Unknown SDK capability');
    await expect(
      executeSdkCall(plugin as never, true, { capability: 'namespace:rem.__proto__' })
    ).rejects.toThrow('Unknown SDK capability');
  });

  it('requires explicit destructive approval', async () => {
    const plugin = new MockRemNotePlugin();
    plugin.addTestRem('remove-me', 'Remove me');

    await expect(
      executeSdkCall(plugin as never, true, {
        capability: 'rem:remove',
        targetId: 'remove-me',
      })
    ).rejects.toThrow('requires allowDestructive=true');

    await expect(
      executeSdkCall(plugin as never, true, {
        capability: 'rem:remove',
        targetId: 'remove-me',
        allowDestructive: true,
      })
    ).resolves.toEqual({
      capability: 'rem:remove',
      value: { $type: 'undefined' },
    });
  });

  it('resolves Date and Rem references recursively', async () => {
    const plugin = new MockRemNotePlugin();
    const referencedRem = plugin.addTestRem('referenced-rem', 'Referenced');
    const dateResult = await executeSdkCall(plugin as never, true, {
      capability: 'namespace:date.getDailyDoc',
      args: [{ $type: 'date', value: '2026-09-18T00:00:00.000Z' }],
    });

    expect(plugin.date.getDailyDoc).toHaveBeenCalledWith(new Date('2026-09-18T00:00:00.000Z'));
    expect(dateResult).toMatchObject({
      capability: 'namespace:date.getDailyDoc',
      value: { $type: 'rem', id: 'daily_doc', text: ['Daily Document'] },
    });

    await executeSdkCall(plugin as never, true, {
      capability: 'namespace:messaging.broadcast',
      args: [{ nested: { $ref: 'rem', id: 'referenced-rem' } }],
    });
    expect(plugin.getBroadcastMessages()).toEqual([{ nested: referencedRem }]);
  });

  it('rejects functions, cycles, and unknown output classes', async () => {
    const plugin = new MockRemNotePlugin();
    plugin.app = {
      ...plugin.app,
      toast: vi.fn(async () => () => undefined),
    } as never;

    await expect(
      executeSdkCall(plugin as never, true, {
        capability: 'namespace:app.toast',
        args: ['hello'],
      })
    ).rejects.toThrow('unsupported function');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      executeSdkCall(plugin as never, true, {
        capability: 'namespace:messaging.broadcast',
        args: [cyclic],
      })
    ).rejects.toThrow('circular reference');

    class UnknownSdkClass {}
    plugin.search.search.mockResolvedValueOnce([new UnknownSdkClass()] as never);
    await expect(
      executeSdkCall(plugin as never, true, {
        capability: 'namespace:search.search',
        args: [['query']],
      })
    ).rejects.toThrow('unsupported class UnknownSdkClass');
  });
});
