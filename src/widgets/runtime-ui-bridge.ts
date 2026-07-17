import { StorageEvents, type ReactRNPlugin } from '@remnote/plugin-sdk';
import type { AutomationBridgeSettings } from '../settings';
import type {
  BridgeRuntime,
  BridgeRuntimeSnapshot,
  HistoryEntry,
  LogEntry,
  SessionStats,
} from '../bridge/runtime';
import { withScopedLogPrefix } from '../logging';

export const BRIDGE_UI_SNAPSHOT_STORAGE_KEY = 'automation-bridge-ui-snapshot';
export const BRIDGE_UI_COMMAND_STORAGE_KEY = 'automation-bridge-ui-command';

export interface SerializedLogEntry extends Omit<LogEntry, 'timestamp'> {
  timestamp: number;
}

export interface SerializedHistoryEntry extends Omit<HistoryEntry, 'timestamp'> {
  timestamp: number;
}

export interface SerializedBridgeRuntimeSnapshot extends Omit<
  BridgeRuntimeSnapshot,
  'logs' | 'history'
> {
  logs: SerializedLogEntry[];
  history: SerializedHistoryEntry[];
}

export type BridgeUiCommand =
  | {
      source: 'widget';
      id: string;
      timestamp: number;
      kind: 'request_snapshot';
    }
  | {
      source: 'widget';
      id: string;
      timestamp: number;
      kind: 'reconnect';
      reason?: string;
    }
  | {
      source: 'widget';
      id: string;
      timestamp: number;
      kind: 'nudge_reconnect';
      reason?: string;
    }
  | {
      source: 'widget';
      id: string;
      timestamp: number;
      kind: 'update_settings';
      settings?: Partial<AutomationBridgeSettings>;
    };

export interface BridgeUiBridgeConfig {
  plugin: Pick<ReactRNPlugin, 'event' | 'storage'>;
  runtime: Pick<
    BridgeRuntime,
    'getSnapshot' | 'subscribe' | 'reconnect' | 'nudgeReconnect' | 'updateSettings'
  >;
}

function serializeStats(stats: SessionStats): SessionStats {
  return { ...stats };
}

export function serializeBridgeRuntimeSnapshot(
  snapshot: BridgeRuntimeSnapshot
): SerializedBridgeRuntimeSnapshot {
  return {
    ...snapshot,
    stats: serializeStats(snapshot.stats),
    logs: snapshot.logs.map((entry) => ({
      ...entry,
      timestamp: entry.timestamp.getTime(),
    })),
    history: snapshot.history.map((entry) => ({
      ...entry,
      timestamp: entry.timestamp.getTime(),
    })),
  };
}

export function deserializeBridgeRuntimeSnapshot(
  snapshot: SerializedBridgeRuntimeSnapshot
): BridgeRuntimeSnapshot {
  return {
    ...snapshot,
    logs: snapshot.logs.map((entry): LogEntry => ({
      ...entry,
      timestamp: new Date(entry.timestamp),
    })),
    history: snapshot.history.map((entry): HistoryEntry => ({
      ...entry,
      timestamp: new Date(entry.timestamp),
    })),
  };
}

export function isSerializedBridgeRuntimeSnapshot(
  snapshot: unknown
): snapshot is SerializedBridgeRuntimeSnapshot {
  return (
    !!snapshot &&
    typeof snapshot === 'object' &&
    'status' in snapshot &&
    typeof (snapshot as { status?: unknown }).status === 'string' &&
    'retryPhase' in snapshot &&
    typeof (snapshot as { retryPhase?: unknown }).retryPhase === 'string' &&
    'logs' in snapshot &&
    Array.isArray((snapshot as { logs?: unknown }).logs) &&
    'history' in snapshot &&
    Array.isArray((snapshot as { history?: unknown }).history)
  );
}

export function isBridgeUiCommand(command: unknown): command is BridgeUiCommand {
  return (
    !!command &&
    typeof command === 'object' &&
    'source' in command &&
    (command as { source?: unknown }).source === 'widget' &&
    'id' in command &&
    typeof (command as { id?: unknown }).id === 'string' &&
    'timestamp' in command &&
    typeof (command as { timestamp?: unknown }).timestamp === 'number' &&
    'kind' in command &&
    typeof (command as { kind?: unknown }).kind === 'string'
  );
}

async function writeSnapshot(
  plugin: Pick<ReactRNPlugin, 'storage'>,
  snapshot: BridgeRuntimeSnapshot
): Promise<void> {
  await plugin.storage.setSession(
    BRIDGE_UI_SNAPSHOT_STORAGE_KEY,
    serializeBridgeRuntimeSnapshot(snapshot)
  );
}

/**
 * Bridges runtime state and commands across RemNote plugin/widget execution contexts via session storage keys.
 */
export function registerBridgeRuntimeUiBridge(config: BridgeUiBridgeConfig): () => void {
  let lastProcessedCommandId: string | null = null;

  const persistCurrentSnapshot = async (): Promise<void> => {
    await writeSnapshot(config.plugin, config.runtime.getSnapshot());
  };

  const unsubscribe = config.runtime.subscribe((snapshot) => {
    void writeSnapshot(config.plugin, snapshot);
  });

  const listener = (command: unknown): void => {
    if (!isBridgeUiCommand(command)) {
      return;
    }

    if (command.id === lastProcessedCommandId) {
      return;
    }
    lastProcessedCommandId = command.id;

    console.log(withScopedLogPrefix('runtime', `Storage command in: ${command.kind}`));

    if (command.kind === 'request_snapshot') {
      void persistCurrentSnapshot();
      return;
    }

    if (command.kind === 'reconnect') {
      config.runtime.reconnect(command.reason ?? 'widget command');
      return;
    }

    if (command.kind === 'nudge_reconnect') {
      config.runtime.nudgeReconnect(command.reason ?? 'widget activity');
      return;
    }

    if (command.kind === 'update_settings') {
      config.runtime.updateSettings(command.settings ?? {});
    }
  };

  config.plugin.event.addListener(
    StorageEvents.StorageSessionChange,
    BRIDGE_UI_COMMAND_STORAGE_KEY,
    listener
  );

  void persistCurrentSnapshot();

  return () => {
    unsubscribe();
    config.plugin.event.removeListener(
      StorageEvents.StorageSessionChange,
      BRIDGE_UI_COMMAND_STORAGE_KEY,
      listener
    );
  };
}
