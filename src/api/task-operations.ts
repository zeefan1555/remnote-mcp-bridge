import {
  RemType,
  type PluginRem,
  type ReactRNPlugin,
  type RichTextInterface,
} from '@remnote/plugin-sdk';
import { contentHash } from './content-hash';
import { plainText } from './plain-text';
import { hasCardStructure } from './card-structure';
import {
  inspectWithEvidence,
  verifyInspection,
  verifyScope,
  type InspectionCheck,
  type ScopeExpectation,
} from './inspection';
export type TextSegment = string | { remId: string } | { pageKey: string };
export interface AnswerPatch {
  key: string;
  cardRemId: string;
  remId: string;
  expectedTextHash: string;
  text: TextSegment[];
}
export interface FlashcardsPlan {
  schemaVersion: 1;
  dailyRemId: string;
  homeRootId: string;
  tagRemId: string;
  title?: string;
  newCards?: Array<{ key: string; question: string; answer: TextSegment[][] }>;
  answerPatches?: AnswerPatch[];
  reusedCardRemIds?: string[];
}
export interface WikiPlan {
  schemaVersion: 1;
  wikiRootId: string;
  partitionRemId: string;
  indexRemId: string;
  logRemId: string;
  pages: Array<{
    key: string;
    remId?: string;
    title: string;
    aliases?: string[];
    nodes: Array<{ key: string; remId?: string; text: TextSegment[]; expectedTextHash?: string }>;
    summary: TextSegment[];
  }>;
  answerPatches?: AnswerPatch[];
}
export interface TaskApplyParams<T> {
  schemaVersion: 1;
  plan: T;
  dryRun?: boolean;
  idempotencyKey: string;
}
type StepState =
  'started' | 'applied' | 'verified' | 'unknown' | 'conflict' | 'failed' | 'incomplete';
interface Step {
  key: string;
  state: StepState;
  remIds: string[];
  error?: string;
}
interface Identity {
  key: string;
  remId: string;
}
export interface TaskReceipt {
  schemaVersion: 1;
  kind: 'flashcards' | 'wiki';
  batchKey: string;
  planHash: string;
  status: 'preview' | 'verified' | 'partial' | 'unknown' | 'incomplete' | 'conflict';
  complete: boolean;
  ids: Record<string, string>;
  facts: Array<{ remId: string; textHash: string; cardIds: string[]; reviewHash: string }>;
  created: Identity[];
  updated: Identity[];
  reused: Identity[];
  skipped: Identity[];
  steps: Step[];
  checks: InspectionCheck[];
  readWindow: { startedAt: string; finishedAt: string };
  errors: Array<{ remId?: string; code: string; message: string }>;
}
interface Journal {
  schemaVersion: 1;
  kind: 'flashcards' | 'wiki';
  batchKey: string;
  planHash: string;
  steps: Record<string, Step>;
  ids: Record<string, string>;
  created: Identity[];
  updated: Identity[];
  reused: Identity[];
  skipped: Identity[];
  createdTextHashes: Record<string, string>;
  createdParentIds: Record<string, string | null>;
  createdChildrenIds: Record<string, string[]>;
  createdTagIds: Record<string, string[]>;
  cardBaselines: Record<string, string>;
  textPreconditions: Record<string, string>;
  textCompleted: Record<string, string>;
  batchDate: string;
  completed: boolean;
}
interface Dependencies {
  plugin: ReactRNPlugin;
  canWrite: () => boolean;
  createNote: (params: {
    title?: string;
    content?: string;
    parentId: string;
    tagRemIds?: string[];
  }) => Promise<{ remIds: string[]; titles: string[] }>;
}
class TaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remId?: string
  ) {
    super(message);
  }
}
function object(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected JSON object');
}
function keys(v: object, fields: string[]): void {
  if (Object.keys(v).some((k) => !fields.includes(k))) throw new Error('Unknown task field');
}
function string(v: unknown, max = 256): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new Error('Invalid bounded string');
}
function array(v: unknown, max: number, min = 0): asserts v is unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > max)
    throw new Error('Invalid bounded array');
}
function key(v: unknown, max = 64): asserts v is string {
  string(v, max);
  if (!/^[A-Za-z0-9._-]+$/.test(v)) throw new Error('Invalid operation key');
}
function hash(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) throw new Error('Expected SHA-256 hash');
}
function segments(v: unknown, pages?: Set<string>): asserts v is TextSegment[] {
  array(v, 100, 1);
  for (const s of v) {
    if (typeof s === 'string') {
      if (s.length > 10000) throw new Error('Text segment too long');
    } else {
      object(s);
      if ('remId' in s) {
        keys(s, ['remId']);
        string(s.remId);
      } else if ('pageKey' in s && pages) {
        keys(s, ['pageKey']);
        key(s.pageKey);
        if (!pages.has(s.pageKey)) throw new Error('Unknown pageKey');
      } else throw new Error('Expected literal text or exact native reference');
    }
  }
}
export function validateTaskPlan(
  kind: 'flashcards' | 'wiki',
  input: TaskApplyParams<FlashcardsPlan | WikiPlan>
): void {
  object(input);
  keys(input, ['schemaVersion', 'plan', 'dryRun', 'idempotencyKey']);
  if (input.schemaVersion !== 1) throw new Error('schemaVersion must equal 1');
  key(input.idempotencyKey, 128);
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean')
    throw new Error('Invalid dryRun');
  object(input.plan);
  const p = input.plan;
  if (p.schemaVersion !== 1) throw new Error('plan.schemaVersion must equal 1');
  if (new TextEncoder().encode(JSON.stringify(p)).length > 100 * 1024)
    throw new Error('Plan exceeds 100 KiB');
  const seen = new Set<string>(),
    unique = (v: unknown) => {
      key(v);
      if (seen.has(v)) throw new Error('Duplicate plan key');
      seen.add(v);
    };
  let pages: Set<string> | undefined,
    count = 0;
  if (kind === 'flashcards') {
    keys(p, [
      'schemaVersion',
      'dailyRemId',
      'homeRootId',
      'tagRemId',
      'title',
      'newCards',
      'answerPatches',
      'reusedCardRemIds',
    ]);
    const plan = p as FlashcardsPlan;
    [plan.dailyRemId, plan.homeRootId, plan.tagRemId].forEach((v) => string(v));
    if (plan.title !== undefined) string(plan.title, 1000);
    if (plan.newCards !== undefined) {
      array(plan.newCards, 7);
      if (plan.newCards.length > 1 && !plan.title) throw new Error('Cluster title required');
      for (const c of plan.newCards) {
        object(c);
        keys(c, ['key', 'question', 'answer']);
        unique(c.key);
        string(c.question, 1000);
        array(c.answer, 100, 1);
        c.answer.forEach((v) => segments(v));
        count += 1 + c.answer.length;
      }
    }
    if (plan.reusedCardRemIds !== undefined) {
      array(plan.reusedCardRemIds, 100);
      plan.reusedCardRemIds.forEach((v) => string(v));
    }
    if (!(plan.newCards?.length || plan.answerPatches?.length || plan.reusedCardRemIds?.length))
      throw new Error('Empty task');
    count +=
      2 +
      (plan.newCards && plan.newCards.length > 1 ? 1 : 0) +
      (plan.reusedCardRemIds?.length ?? 0);
  } else {
    keys(p, [
      'schemaVersion',
      'wikiRootId',
      'partitionRemId',
      'indexRemId',
      'logRemId',
      'pages',
      'answerPatches',
    ]);
    const plan = p as WikiPlan;
    [plan.wikiRootId, plan.partitionRemId, plan.indexRemId, plan.logRemId].forEach((v) =>
      string(v)
    );
    array(plan.pages, 10);
    pages = new Set(plan.pages.map((pg) => pg.key));
    for (const pg of plan.pages) {
      object(pg);
      keys(pg, ['key', 'remId', 'title', 'aliases', 'nodes', 'summary']);
      unique(pg.key);
      string(pg.title, 1000);
      if (pg.remId !== undefined) string(pg.remId);
      if (pg.aliases !== undefined) {
        array(pg.aliases, 20);
        pg.aliases.forEach((v) => string(v, 200));
      }
      array(pg.nodes, 100);
      for (const n of pg.nodes) {
        object(n);
        keys(n, ['key', 'remId', 'text', 'expectedTextHash']);
        unique(n.key);
        if (n.remId !== undefined) {
          string(n.remId);
          hash(n.expectedTextHash);
        } else if (n.expectedTextHash !== undefined)
          throw new Error('New node cannot have original hash');
        segments(n.text, pages);
      }
      segments(pg.summary, pages);
      count += 2 + pg.nodes.length;
    }
    count++;
    if (!plan.pages.length && !plan.answerPatches?.length) throw new Error('Empty task');
  }
  if (p.answerPatches !== undefined) {
    array(p.answerPatches, 100);
    for (const patch of p.answerPatches) {
      object(patch);
      keys(patch, ['key', 'cardRemId', 'remId', 'expectedTextHash', 'text']);
      unique(patch.key);
      string(patch.cardRemId);
      string(patch.remId);
      hash(patch.expectedTextHash);
      segments(patch.text, pages);
    }
    count += 2 * p.answerPatches.length;
  }
  if (count > 1000) throw new Error('Combined receipt exceeds 1000 IDs');
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])])
    );
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const nativeIds = (v: PluginRem[]): string[] => {
  if (!Array.isArray(v) || v.some((r) => !r || typeof r._id !== 'string' || !r._id))
    throw new Error('Malformed SDK Rem list');
  return v.map((r) => r._id);
};
export class TaskOperations {
  private busy = false;
  private deadline = 0;
  constructor(private deps: Dependencies) {}
  async apply(
    kind: 'flashcards' | 'wiki',
    input: TaskApplyParams<FlashcardsPlan | WikiPlan>
  ): Promise<TaskReceipt> {
    validateTaskPlan(kind, input);
    const startedAt = new Date().toISOString(),
      planHash = await contentHash(canonical(input.plan));
    const receipt: TaskReceipt = {
      schemaVersion: 1,
      kind,
      batchKey: input.idempotencyKey,
      planHash,
      status: 'preview',
      complete: false,
      ids: {},
      facts: [],
      created: [],
      updated: [],
      reused: [],
      skipped: [],
      steps: [],
      checks: [],
      readWindow: { startedAt, finishedAt: startedAt },
      errors: [],
    };
    if (this.busy) {
      receipt.status = 'incomplete';
      receipt.errors.push({
        code: 'busy',
        message: 'Another task is active; do not duplicate the batch',
      });
      return receipt;
    }
    this.busy = true;
    this.deadline = Date.now() + 45000;
    let j: Journal | undefined;
    try {
      const kb = await this.deps.plugin.kb.getCurrentKnowledgeBaseData();
      if (!kb?._id) throw new TaskError('missing_kb', 'No current knowledge base');
      const storageKey = `task-v1:${kb._id}:${kind}:${input.idempotencyKey}`;
      const prior =
        input.dryRun === false
          ? await this.deps.plugin.storage.getLocal<Journal>(storageKey)
          : undefined;
      if (
        prior &&
        (prior.schemaVersion !== 1 ||
          prior.kind !== kind ||
          prior.batchKey !== input.idempotencyKey ||
          prior.planHash !== planHash)
      )
        throw new TaskError('conflict', 'Idempotency key belongs to a different plan');
      j = prior ?? {
        schemaVersion: 1,
        kind,
        batchKey: input.idempotencyKey,
        planHash,
        steps: {},
        ids: {},
        created: [],
        updated: [],
        reused: [],
        skipped: [],
        createdTextHashes: {},
        createdParentIds: {},
        createdChildrenIds: {},
        createdTagIds: {},
        cardBaselines: {},
        textPreconditions: {},
        textCompleted: {},
        batchDate: startedAt.slice(0, 10),
        completed: false,
      };
      if (Object.values(j.steps).some((s) => ['started', 'unknown'].includes(s.state)))
        throw new TaskError(
          'unknown',
          'Prior creation outcome is unknown; reconcile exact IDs before retry'
        );
      if (kind === 'wiki')
        for (const p of (input.plan as WikiPlan).pages) {
          const k = `page:${p.key}`,
            step = j.steps[k];
          if (
            !p.remId &&
            !j.ids[k] &&
            step &&
            ['applied', 'verified'].includes(step.state) &&
            step.remIds.length === 1
          )
            j.ids[k] = step.remIds[0];
        }
      const journal = j,
        save = () => this.mutate(() => this.deps.plugin.storage.setLocal(storageKey, journal));
      await this.preflight(kind, input.plan, j);
      receipt.checks.push({
        kind: 'preflight',
        remId:
          kind === 'wiki'
            ? (input.plan as WikiPlan).wikiRootId
            : (input.plan as FlashcardsPlan).dailyRemId,
        status: 'passed',
        expected: { planHash },
        actual: { validated: true },
      });
      if (input.dryRun !== false) {
        receipt.complete = true;
        return receipt;
      }
      await save();
      if (kind === 'flashcards')
        await this.flashcards(input.plan as FlashcardsPlan, j, save, receipt);
      else await this.wiki(input.plan as WikiPlan, j, save, receipt);
      j.completed = true;
      await save();
      receipt.status = 'verified';
      receipt.complete = true;
    } catch (e) {
      const code = e instanceof TaskError ? e.code : 'operation_failed';
      receipt.errors.push({
        ...(e instanceof TaskError && e.remId ? { remId: e.remId } : {}),
        code,
        message: e instanceof Error ? e.message : String(e),
      });
      receipt.status =
        code === 'conflict'
          ? 'conflict'
          : code === 'unknown' ||
              Object.values(j?.steps ?? {}).some((s) => ['started', 'unknown'].includes(s.state))
            ? 'unknown'
            : j?.created.length || j?.updated.length
              ? 'partial'
              : 'incomplete';
      receipt.complete = false;
    } finally {
      this.busy = false;
      if (j) {
        receipt.ids = { ...j.ids };
        for (const field of ['created', 'updated', 'reused', 'skipped'] as const)
          receipt[field] = [...j[field]];
        receipt.steps = Object.values(j.steps);
      }
      receipt.readWindow.finishedAt = new Date().toISOString();
    }
    return receipt;
  }
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    if (Date.now() > this.deadline) throw new TaskError('incomplete', 'Task deadline exhausted');
    if (!this.deps.canWrite()) throw new TaskError('write_disabled', 'Bridge writes disabled');
    return await fn();
  }
  private async rem(id: string): Promise<PluginRem> {
    const r = await this.deps.plugin.rem.findOne(id);
    if (!r || r._id !== id) throw new TaskError('missing_rem', 'Rem missing or inaccessible', id);
    return r;
  }
  private add(
    j: Journal,
    kind: 'created' | 'updated' | 'reused' | 'skipped',
    key: string,
    id: string
  ): void {
    if (!j[kind].some((e) => e.key === key && e.remId === id)) j[kind].push({ key, remId: id });
  }
  private async within(rem: PluginRem, id: string): Promise<boolean> {
    const seen = new Set<string>();
    let r: PluginRem | undefined = rem;
    for (let i = 0; r && i < 100; i++) {
      if (r._id === id) return true;
      if (seen.has(r._id)) throw new TaskError('incomplete', 'Ancestor cycle', r._id);
      seen.add(r._id);
      r = await r.getParentRem();
    }
    return false;
  }
  private async plain(rem: PluginRem): Promise<boolean> {
    const [folder, doc, tags, item, cards] = await Promise.all([
      rem.isFolder(),
      rem.isDocument(),
      rem.getTagRems(),
      rem.isCardItem(),
      rem.getCards(),
    ]);
    if (
      typeof folder !== 'boolean' ||
      typeof doc !== 'boolean' ||
      typeof item !== 'boolean' ||
      !Array.isArray(cards)
    )
      throw new Error('Malformed plain-node facts');
    return (
      rem.type === RemType.DEFAULT_TYPE &&
      !folder &&
      !doc &&
      !nativeIds(tags).length &&
      !cards.length &&
      !hasCardStructure(rem.text, rem.backText, item)
    );
  }
  private async assertPlain(
    id: string,
    parents: Array<string | null>,
    hashes: string[]
  ): Promise<{ rem: PluginRem; parentId: string | null; textHash: string }> {
    const rem = await this.rem(id);
    if (!(await this.plain(rem)))
      throw new TaskError(
        'conflict',
        'Wiki target must remain ordinary untagged non-card text',
        id
      );
    const parentId = (await rem.getParentRem())?._id ?? null;
    if (!parents.includes(parentId))
      throw new TaskError('conflict', 'Wiki parent changed externally', id);
    const textHash = await contentHash(rem.text);
    if (!hashes.includes(textHash))
      throw new TaskError('conflict', 'Wiki text changed externally', id);
    return { rem, parentId, textHash };
  }
  private async checkSegments(text: TextSegment[]): Promise<void> {
    for (const part of text)
      if (typeof part !== 'string' && 'remId' in part) await this.rem(part.remId);
  }
  private async richText(text: TextSegment[], j: Journal): Promise<RichTextInterface> {
    const out: RichTextInterface = [];
    for (const p of text) {
      if (typeof p === 'string') out.push(p);
      else {
        const id = 'remId' in p ? p.remId : j.ids[`page:${p.pageKey}`];
        if (!id) throw new TaskError('incomplete', 'Unresolved page binding');
        const target = await this.rem(id);
        const reference = await this.deps.plugin.richText.rem(target).value();
        if (
          !reference.some(
            (p) =>
              typeof p === 'object' &&
              p !== null &&
              'i' in p &&
              p.i === 'q' &&
              '_id' in p &&
              p._id === id
          )
        )
          throw new TaskError(
            'incomplete',
            'SDK native reference did not preserve the requested ID',
            id
          );
        out.push(...reference);
      }
    }
    return out;
  }
  private async assertReferences(rem: PluginRem, text: RichTextInterface): Promise<void> {
    const expected = text.flatMap((p) =>
      typeof p === 'object' &&
      p !== null &&
      'i' in p &&
      p.i === 'q' &&
      '_id' in p &&
      typeof p._id === 'string'
        ? [p._id]
        : []
    );
    if (!expected.length) return;
    const actual = nativeIds(await rem.remsBeingReferenced());
    if (expected.some((id) => !actual.includes(id)))
      throw new TaskError('incomplete', 'Native references did not resolve after writing', rem._id);
  }
  private async allowedPatch(
    rem: PluginRem,
    expected: string,
    text: TextSegment[],
    j: Journal
  ): Promise<void> {
    const current = await contentHash(rem.text);
    if (text.some((p) => typeof p !== 'string' && 'pageKey' in p && !j.ids[`page:${p.pageKey}`])) {
      if (current !== expected)
        throw new TaskError('conflict', 'Text changed since inspection', rem._id);
      return;
    }
    if (current !== expected && current !== (await contentHash(await this.richText(text, j))))
      throw new TaskError('conflict', 'Text changed since inspection', rem._id);
  }
  private async preflight(
    kind: 'flashcards' | 'wiki',
    input: FlashcardsPlan | WikiPlan,
    j: Journal
  ): Promise<void> {
    if (kind === 'flashcards') {
      const p = input as FlashcardsPlan,
        evidence = await inspectWithEvidence(this.deps.plugin, {
          schemaVersion: 1,
          remIds: [p.dailyRemId, p.homeRootId, p.tagRemId],
        });
      const context = evidence.result;
      if (!context.complete)
        throw new TaskError('incomplete', 'Cannot read daily/HOME/tag context');
      const ancestry = verifyInspection(
        context,
        {
          schemaVersion: 1,
          inspect: { schemaVersion: 1, remIds: [p.dailyRemId, p.homeRootId, p.tagRemId] },
          expectations: [{ kind: 'ancestor', remId: p.tagRemId, value: p.homeRootId }],
        },
        evidence.ancestorTails
      );
      if (ancestry.status === 'incomplete')
        throw new TaskError(
          'incomplete',
          'HOME ancestry requires the unread ancestor tail',
          p.tagRemId
        );
      const daily = context.objects.find((o) => o.remId === p.dailyRemId),
        home = context.objects.find((o) => o.remId === p.homeRootId),
        tag = context.objects.find((o) => o.remId === p.tagRemId);
      if (
        daily?.remType !== 'dailyDocument' ||
        home?.remType !== 'folder' ||
        tag?.remType !== 'concept' ||
        !tag.ancestorRemIds.includes(p.homeRootId)
      )
        throw new TaskError(
          'conflict',
          'Expected existing daily document and HOME descendant Concept Tag'
        );
      for (const card of p.newCards ?? [])
        for (const line of card.answer) await this.checkSegments(line);
      for (const id of p.reusedCardRemIds ?? [])
        if (!(await (await this.rem(id)).getCards()).length)
          throw new TaskError('conflict', 'Reused Rem is not a card', id);
    } else {
      const p = input as WikiPlan,
        root = await this.rem(p.wikiRootId),
        partition = await this.rem(p.partitionRemId),
        index = await this.rem(p.indexRemId),
        log = await this.rem(p.logRemId);
      if (
        !(await root.isFolder()) ||
        !(await root.hasPowerup('u')) ||
        !(await partition.isFolder()) ||
        !(await this.within(partition, root._id)) ||
        !(await index.isDocument()) ||
        (await index.isFolder()) ||
        !(await log.isDocument()) ||
        (await log.isFolder()) ||
        !(await this.within(index, root._id)) ||
        !(await this.within(log, root._id))
      )
        throw new TaskError(
          'conflict',
          'Expected disabled WIKI folders and index/log documents within WIKI'
        );
      const siblings = await partition.getChildrenRem();
      if (siblings.length > 1000)
        throw new TaskError('incomplete', 'Partition duplicate scope exceeds limit');
      const graph = await this.indexGraph(index),
        names = new Map<string, string>(),
        normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      for (const pg of p.pages) {
        const choices = [pg.title, ...(pg.aliases ?? [])].map(normalize);
        for (const name of choices) {
          if (names.has(name) && names.get(name) !== pg.key)
            throw new TaskError('conflict', 'Planned canonical names/aliases collide');
          names.set(name, pg.key);
        }
        const own = pg.remId ?? j.ids[`page:${pg.key}`],
          entries = own ? await this.indexEntries(index, own, graph) : [];
        if (!graph.flat && entries.length !== 1)
          throw new TaskError(
            'conflict',
            'Grouped index requires an existing unique page entry; create the exact section entry explicitly first',
            own
          );
        for (const sibling of siblings) {
          if (sibling._id === own) continue;
          const texts = [sibling.text, ...(await sibling.getAliases()).map((a) => a.text)];
          const rendered = await Promise.all(
            texts.map((text) => plainText(this.deps.plugin, text))
          );
          if (rendered.some((text) => choices.includes(normalize(text))))
            throw new TaskError(
              'conflict',
              'Canonical name or alias already exists; use exact page ID',
              sibling._id
            );
        }
        if (own) {
          const parents: Array<string | null> = [p.partitionRemId],
            hashes = [await contentHash([pg.title])];
          if (!pg.remId && !j.completed && j.steps[`page:${pg.key}`]?.state !== 'verified') {
            if (Object.hasOwn(j.createdParentIds, own)) parents.push(j.createdParentIds[own]);
            if (j.createdTextHashes[own]) hashes.push(j.createdTextHashes[own]);
          }
          await this.assertPlain(own, parents, hashes);
        }
        for (const n of pg.nodes) {
          await this.checkSegments(n.text);
          if (n.remId) {
            if (!own)
              throw new TaskError('conflict', 'Existing node requires existing page', n.remId);
            const r = await this.rem(n.remId);
            if (!(await this.plain(r)) || (await r.getParentRem())?._id !== own)
              throw new TaskError(
                'conflict',
                'Existing Wiki node must be plain and within exact page',
                n.remId
              );
            await this.allowedPatch(r, n.expectedTextHash!, n.text, j);
          }
        }
        await this.checkSegments(pg.summary);
      }
    }
    for (const patch of input.answerPatches ?? []) {
      const answer = await this.rem(patch.remId),
        card = await this.rem(patch.cardRemId);
      if ((await answer.getParentRem())?._id !== card._id || !(await card.getCards()).length)
        throw new TaskError(
          'conflict',
          'Answer must be direct child of exact existing card',
          answer._id
        );
      await this.checkSegments(patch.text);
      await this.allowedPatch(answer, patch.expectedTextHash, patch.text, j);
    }
  }
  private async create(
    k: string,
    j: Journal,
    save: () => Promise<void>,
    action: () => Promise<string[]>
  ): Promise<string[]> {
    const old = j.steps[k];
    if (old) {
      if (['started', 'unknown'].includes(old.state))
        throw new TaskError('unknown', 'Creation outcome unknown');
      for (const id of old.remIds) await this.rem(id);
      return old.remIds;
    }
    if (j.completed) throw new TaskError('conflict', 'Completed task cannot create missing object');
    j.steps[k] = { key: k, state: 'started', remIds: [] };
    await save();
    try {
      const ids = await this.mutate(action);
      if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Ambiguous created IDs');
      for (const id of ids) {
        const r = await this.rem(id);
        j.createdTextHashes[id] = await contentHash(r.text);
        j.createdParentIds[id] = (await r.getParentRem())?._id ?? null;
        j.createdChildrenIds[id] = nativeIds(await r.getChildrenRem());
        j.createdTagIds[id] = nativeIds(await r.getTagRems()).sort();
        this.add(j, 'created', k, id);
      }
      j.steps[k] = { key: k, state: 'applied', remIds: ids };
      await save();
      return ids;
    } catch (e) {
      j.steps[k].state = 'unknown';
      j.steps[k].error = e instanceof Error ? e.message : String(e);
      try {
        await save();
      } catch {
        /* Persisted started state also blocks retry. */
      }
      throw new TaskError('unknown', `Creation ${k} may have succeeded; reconcile exact IDs`);
    }
  }
  private async createPlain(
    k: string,
    parentId: string,
    text: TextSegment[],
    j: Journal,
    save: () => Promise<void>
  ): Promise<PluginRem> {
    const ids = await this.create(k, j, save, async () => {
      const r = await this.deps.plugin.rem.createRem();
      if (!r) throw new Error('SDK did not create Rem');
      return [r._id];
    });
    const id = ids[0],
      desired = await this.richText(text, j),
      desiredHash = await contentHash(desired),
      parents: Array<string | null> = [parentId],
      hashes = [desiredHash];
    if (!j.completed && j.steps[k].state !== 'verified') {
      if (Object.hasOwn(j.createdParentIds, id)) parents.push(j.createdParentIds[id]);
      if (j.createdTextHashes[id]) hashes.push(j.createdTextHashes[id]);
    }
    const target = await this.rem(parentId),
      before = await this.assertPlain(id, parents, hashes);
    if (before.parentId !== parentId) await this.mutate(() => before.rem.setParent(target));
    const fresh = await this.assertPlain(id, [parentId], hashes);
    if (fresh.textHash !== desiredHash) await this.mutate(() => fresh.rem.setText(desired));
    const readback = await this.assertPlain(id, [parentId], [desiredHash]);
    await this.assertReferences(readback.rem, desired);
    j.steps[k].state = 'verified';
    j.ids[k] = id;
    await save();
    return readback.rem;
  }
  private async patch(
    k: string,
    id: string,
    expected: string,
    text: TextSegment[],
    j: Journal,
    save: () => Promise<void>,
    parentId: string,
    plain: boolean
  ): Promise<void> {
    const desired = await this.richText(text, j),
      desiredHash = await contentHash(desired),
      hashes =
        j.completed || j.steps[k]?.state === 'verified' ? [desiredHash] : [desiredHash, expected];
    let rem: PluginRem, actual: string;
    if (plain) {
      const current = await this.assertPlain(id, [parentId], hashes);
      rem = current.rem;
      actual = current.textHash;
    } else {
      rem = await this.rem(id);
      if ((await rem.getParentRem())?._id !== parentId)
        throw new TaskError('conflict', 'Answer parent changed', id);
      actual = await contentHash(rem.text);
      if (!hashes.includes(actual)) throw new TaskError('conflict', 'Answer text changed', id);
    }
    if (actual !== desiredHash) {
      await this.mutate(() => rem.setText(desired));
      this.add(j, 'updated', k, id);
    } else this.add(j, 'skipped', k, id);
    const after = await this.rem(id);
    if (
      (await contentHash(after.text)) !== desiredHash ||
      (await after.getParentRem())?._id !== parentId ||
      (plain && !(await this.plain(after)))
    )
      throw new TaskError('incomplete', 'Patch readback did not match', id);
    await this.assertReferences(after, desired);
    j.steps[k] = { key: k, state: 'verified', remIds: [id] };
    await save();
  }
  private async cardFacts(rem: PluginRem): Promise<unknown> {
    return {
      remId: rem._id,
      textHash: await contentHash(rem.text),
      parentRemId: (await rem.getParentRem())?._id,
      children: nativeIds(await rem.getChildrenRem()),
      tags: nativeIds(await rem.getTagRems()).sort(),
      cards: (await rem.getCards()).map((c) => ({
        cardId: c._id,
        type: c.type,
        createdAt: c.createdAt,
        repetitionHistory: c.repetitionHistory ?? [],
        nextRepetitionTime: c.nextRepetitionTime,
        lastRepetitionTime: c.lastRepetitionTime,
        timesWrongInRow: c.timesWrongInRow,
      })),
    };
  }
  private async facts(ids: string[], receipt: TaskReceipt): Promise<void> {
    for (const id of [...new Set(ids)]) {
      const r = await this.rem(id),
        cards = (await r.getCards()).map((c) => ({
          cardId: c._id,
          remId: c.remId,
          type: c.type,
          createdAt: c.createdAt,
          repetitionHistory: c.repetitionHistory ?? [],
          ...(c.nextRepetitionTime === undefined
            ? {}
            : { nextRepetitionTime: c.nextRepetitionTime }),
          ...(c.lastRepetitionTime === undefined
            ? {}
            : { lastRepetitionTime: c.lastRepetitionTime }),
          ...(c.timesWrongInRow === undefined ? {} : { timesWrongInRow: c.timesWrongInRow }),
        }));
      receipt.facts = receipt.facts.filter((f) => f.remId !== id);
      receipt.facts.push({
        remId: id,
        textHash: await contentHash(r.text),
        cardIds: cards.map((c) => c.cardId),
        reviewHash: await contentHash(canonical(cards)),
      });
    }
  }
  private async patchAnswers(
    patches: AnswerPatch[],
    j: Journal,
    save: () => Promise<void>,
    receipt: TaskReceipt
  ): Promise<void> {
    for (const p of patches) {
      const card = await this.rem(p.cardRemId),
        before = await contentHash(canonical(await this.cardFacts(card)));
      j.cardBaselines[card._id] ??= before;
      if (j.cardBaselines[card._id] !== before)
        throw new TaskError('conflict', 'Card identity or review facts changed', card._id);
      await save();
      await this.patch(
        `patch:${p.key}`,
        p.remId,
        p.expectedTextHash,
        p.text,
        j,
        save,
        p.cardRemId,
        false
      );
      if ((await contentHash(canonical(await this.cardFacts(await this.rem(card._id))))) !== before)
        throw new TaskError(
          'incomplete',
          'Card identity or history changed during answer patch',
          card._id
        );
      await this.facts([p.cardRemId, p.remId], receipt);
    }
  }
  private async bindScaffold(p: FlashcardsPlan, ids: string[], j: Journal): Promise<void> {
    const all = await Promise.all(ids.map((id) => this.rem(id))),
      roots: PluginRem[] = [];
    for (const r of all) if ((await r.getParentRem())?._id === p.dailyRemId) roots.push(r);
    if (roots.length !== 1) throw new TaskError('incomplete', 'Ambiguous scaffold root');
    const cards = p.newCards!,
      root = roots[0],
      cardRems = cards.length > 1 ? await root.getChildrenRem() : [root],
      bindings: Record<string, string> = { root: root._id };
    if (cards.length !== cardRems.length)
      throw new TaskError('incomplete', 'Scaffold card count mismatch');
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i],
        r = cardRems[i],
        answers = await r.getChildrenRem();
      bindings[`card:${c.key}`] = r._id;
      if (answers.length !== c.answer.length)
        throw new TaskError('incomplete', 'Scaffold answer count mismatch', r._id);
      answers.forEach((a, n) => {
        bindings[`answer:${c.key}:${n}`] = a._id;
      });
    }
    const bound = new Set(Object.values(bindings)),
      expected = cards.reduce((n, c) => n + 1 + c.answer.length, cards.length > 1 ? 1 : 0);
    if (bound.size !== expected || ids.length !== expected || ids.some((id) => !bound.has(id)))
      throw new TaskError('incomplete', 'Ambiguous scaffold semantic bindings');
    Object.assign(j.ids, bindings);
  }
  private async location(r: PluginRem, j: Journal): Promise<void> {
    if (
      !Object.hasOwn(j.createdParentIds, r._id) ||
      !j.createdChildrenIds[r._id] ||
      !j.createdTagIds[r._id]
    )
      throw new TaskError('conflict', 'Missing durable scaffold baseline', r._id);
    const parent = (await r.getParentRem())?._id ?? null;
    if (
      parent !== j.createdParentIds[r._id] ||
      !same(nativeIds(await r.getChildrenRem()), j.createdChildrenIds[r._id]) ||
      !same(nativeIds(await r.getTagRems()).sort(), j.createdTagIds[r._id])
    )
      throw new TaskError('conflict', 'Scaffold parent, children or tags changed', r._id);
    if (
      parent &&
      j.createdChildrenIds[parent] &&
      !same(
        nativeIds(await (await this.rem(parent)).getChildrenRem()),
        j.createdChildrenIds[parent]
      )
    )
      throw new TaskError('conflict', 'Scaffold sibling order changed', r._id);
  }
  private async boundScaffold(
    p: FlashcardsPlan,
    ids: string[],
    j: Journal
  ): Promise<{ root: PluginRem; cards: PluginRem[]; answers: PluginRem[][] }> {
    const cards = p.newCards!,
      needed = [
        'root',
        ...cards.flatMap((c) => [
          `card:${c.key}`,
          ...c.answer.map((_, i) => `answer:${c.key}:${i}`),
        ]),
      ];
    if (needed.some((k) => !j.ids[k] || !ids.includes(j.ids[k])))
      throw new TaskError('conflict', 'Missing durable semantic binding');
    const bound = new Set(needed.map((k) => j.ids[k])),
      expected = cards.reduce((n, c) => n + 1 + c.answer.length, cards.length > 1 ? 1 : 0);
    if (bound.size !== expected || ids.length !== expected || ids.some((id) => !bound.has(id)))
      throw new TaskError('conflict', 'Inconsistent scaffold bindings');
    const root = await this.rem(j.ids.root),
      remCards = await Promise.all(cards.map((c) => this.rem(j.ids[`card:${c.key}`]))),
      answers = await Promise.all(
        cards.map((c) =>
          Promise.all(c.answer.map((_, i) => this.rem(j.ids[`answer:${c.key}:${i}`])))
        )
      );
    const baseline = (id: string, parent: string, children: string[]) => {
      if (j.createdParentIds[id] !== parent || !same(j.createdChildrenIds[id], children))
        throw new TaskError('conflict', 'Baseline disagrees with semantic bindings', id);
    };
    if (cards.length > 1)
      baseline(
        root._id,
        p.dailyRemId,
        remCards.map((r) => r._id)
      );
    else if (root._id !== remCards[0]._id)
      throw new TaskError('conflict', 'Single card root binding changed');
    for (let i = 0; i < cards.length; i++) {
      baseline(
        remCards[i]._id,
        cards.length > 1 ? root._id : p.dailyRemId,
        answers[i].map((r) => r._id)
      );
      for (const a of answers[i]) baseline(a._id, remCards[i]._id, []);
    }
    for (const id of ids) await this.location(await this.rem(id), j);
    return { root, cards: remCards, answers };
  }
  private async createdText(
    id: string,
    text: RichTextInterface,
    j: Journal,
    save: () => Promise<void>
  ): Promise<void> {
    const r = await this.rem(id);
    await this.location(r, j);
    if (r.type !== RemType.DEFAULT_TYPE || (await r.isFolder()) || (await r.isDocument()))
      throw new TaskError('conflict', 'Created card node was retyped', id);
    const actual = await contentHash(r.text),
      desired = await contentHash(text);
    if (
      actual !== desired &&
      (j.completed || j.textCompleted[id] || actual !== j.createdTextHashes[id])
    )
      throw new TaskError('conflict', 'Created text changed externally', id);
    if (actual !== desired) await this.mutate(() => r.setText(text));
    if ((await contentHash((await this.rem(id)).text)) !== desired)
      throw new TaskError('incomplete', 'Created text readback mismatch', id);
    await this.assertReferences(await this.rem(id), text);
    j.textCompleted[id] = desired;
    await save();
  }
  private async flashcards(
    p: FlashcardsPlan,
    j: Journal,
    save: () => Promise<void>,
    receipt: TaskReceipt
  ): Promise<void> {
    j.ids.daily = p.dailyRemId;
    j.ids.tag = p.tagRemId;
    const cards = p.newCards ?? [];
    if (cards.length) {
      const scaffold = cards
          .map(
            (c, i) =>
              `- Task card ${i + 1} ===\n${c.answer.map((_, n) => `    - Answer ${n + 1}`).join('\n')}`
          )
          .join('\n'),
        ids = await this.create('create:cards', j, save, async () => {
          const result = await this.deps.createNote({
            ...(cards.length > 1 ? { title: 'Task card cluster' } : {}),
            content: scaffold,
            parentId: p.dailyRemId,
            tagRemIds: [p.tagRemId],
          });
          await this.bindScaffold(p, result.remIds, j);
          return result.remIds;
        });
      const bound = await this.boundScaffold(p, ids, j);
      for (let i = 0; i < cards.length; i++) {
        await this.createdText(bound.cards[i]._id, [cards[i].question], j, save);
        for (let n = 0; n < cards[i].answer.length; n++)
          await this.createdText(
            bound.answers[i][n]._id,
            await this.richText(cards[i].answer[n], j),
            j,
            save
          );
      }
      if (cards.length > 1) {
        await this.createdText(bound.root._id, [p.title!], j, save);
        if (!(await bound.root.hasPowerup('cc'))) {
          if (j.completed)
            throw new TaskError('conflict', 'Completed cluster powerup changed', bound.root._id);
          const r = await this.rem(bound.root._id);
          await this.location(r, j);
          if (
            (await r.isFolder()) ||
            (await r.isDocument()) ||
            r.type !== RemType.DEFAULT_TYPE ||
            (await r.getCards()).length
          )
            throw new TaskError('conflict', 'Cluster target changed', r._id);
          await this.mutate(() => r.addPowerup('cc'));
        }
      }
      for (const tag of await bound.root.getTagRems())
        if (tag._id !== p.tagRemId && (await this.within(tag, p.homeRootId)))
          throw new TaskError('conflict', 'Additional HOME classification', bound.root._id);
      if (cards.length > 1)
        for (const card of bound.cards)
          for (const tag of await card.getTagRems())
            if (await this.within(tag, p.homeRootId))
              throw new TaskError('conflict', 'Cluster child repeats HOME tag', card._id);
      const expectations: ScopeExpectation[] = [
        { kind: 'parent', remId: bound.root._id, value: p.dailyRemId },
        { kind: 'tag', remId: bound.root._id, value: p.tagRemId },
        { kind: 'cardRemIds', remId: bound.root._id, value: bound.cards.map((r) => r._id) },
      ];
      if (cards.length > 1)
        expectations.push(
          { kind: 'remType', remId: bound.root._id, value: 'text' },
          { kind: 'powerup', remId: bound.root._id, code: 'cc', value: true }
        );
      const verified = await verifyScope(this.deps.plugin, {
        schemaVersion: 1,
        inspect: {
          schemaVersion: 1,
          remIds: [bound.root._id],
          subtreeRootIds: [bound.root._id],
          tagRemIds: [p.tagRemId],
        },
        expectations,
      });
      receipt.checks.push(...verified.checks);
      if (verified.status !== 'passed')
        throw new TaskError('incomplete', 'Card structure verification failed');
      await this.boundScaffold(p, ids, j);
      j.steps['create:cards'].state = 'verified';
      await save();
      await this.facts(ids, receipt);
    }
    await this.patchAnswers(p.answerPatches ?? [], j, save, receipt);
    for (const id of p.reusedCardRemIds ?? []) {
      this.add(j, 'reused', `reuse:${id}`, id);
      await this.facts([id], receipt);
    }
  }
  private async indexGraph(index: PluginRem): Promise<{ entries: PluginRem[]; flat: boolean }> {
    const entries: PluginRem[] = [],
      seen = new Set([index._id]),
      queue = [{ rem: index, depth: 0 }];
    let flat = true;
    for (let i = 0; i < queue.length; i++) {
      const { rem, depth } = queue[i],
        children = await rem.getChildrenRem();
      nativeIds(children);
      if (depth > 0 && children.length) flat = false;
      if (depth >= 100 && children.length) throw new TaskError('incomplete', 'Index depth limit');
      for (const child of children) {
        if (seen.has(child._id)) throw new TaskError('incomplete', 'Repeated entity in index');
        if (entries.length >= 1000) throw new TaskError('incomplete', 'Index scope limit');
        if ((await child.getParentRem())?._id !== rem._id)
          throw new TaskError('incomplete', 'Index child/parent edge inconsistent', child._id);
        seen.add(child._id);
        entries.push(child);
        queue.push({ rem: child, depth: depth + 1 });
      }
    }
    return { entries, flat };
  }
  private async indexEntries(
    index: PluginRem,
    pageId: string,
    graph?: { entries: PluginRem[]; flat: boolean }
  ): Promise<PluginRem[]> {
    const entries: PluginRem[] = [];
    for (const entry of (graph ?? (await this.indexGraph(index))).entries) {
      const first = (entry.text ?? []).find((p) => typeof p !== 'string' || p.trim()),
        owner =
          first && typeof first === 'object' && 'i' in first && first.i === 'q' && '_id' in first
            ? first._id
            : undefined;
      if (owner === pageId) entries.push(entry);
      else if (!owner && (await entry.remsBeingReferenced()).some((r) => r._id === pageId))
        throw new TaskError('conflict', 'Index primary page reference is ambiguous', entry._id);
    }
    if (entries.length > 1) throw new TaskError('conflict', 'Duplicate index page owner', pageId);
    return entries;
  }
  private async wiki(
    p: WikiPlan,
    j: Journal,
    save: () => Promise<void>,
    receipt: TaskReceipt
  ): Promise<void> {
    for (const pg of p.pages) {
      const k = `page:${pg.key}`;
      if (pg.remId) {
        j.ids[k] = pg.remId;
        this.add(j, 'reused', pg.key, pg.remId);
      } else j.ids[k] = (await this.createPlain(k, p.partitionRemId, [pg.title], j, save))._id;
      await save();
    }
    for (const pg of p.pages) {
      const id = j.ids[`page:${pg.key}`],
        r = await this.rem(id);
      for (const alias of pg.aliases ?? []) {
        if (!(await r.getAliases()).some((a) => same(a.text, [alias]))) {
          if (j.completed) throw new TaskError('conflict', 'Completed alias changed', id);
          const current = await this.assertPlain(
            id,
            [p.partitionRemId],
            [await contentHash([pg.title])]
          );
          await this.mutate(() => current.rem.getOrCreateAliasWithText([alias]));
          this.add(j, 'updated', `aliases:${pg.key}`, id);
        }
        if (!(await r.getAliases()).some((a) => same(a.text, [alias])))
          throw new TaskError('incomplete', 'Alias readback mismatch', id);
      }
      for (const n of pg.nodes) {
        const k = `node:${n.key}`;
        if (n.remId) {
          await this.patch(k, n.remId, n.expectedTextHash!, n.text, j, save, id, true);
          j.ids[k] = n.remId;
        } else j.ids[k] = (await this.createPlain(k, id, n.text, j, save))._id;
      }
      const index = await this.rem(p.indexRemId),
        matches = await this.indexEntries(index, id),
        k = `index:${pg.key}`,
        text: TextSegment[] = [{ remId: id }, ' — ', ...pg.summary];
      if (j.ids[k] && (matches.length !== 1 || matches[0]._id !== j.ids[k]))
        throw new TaskError('conflict', 'Recorded index owner changed', id);
      if (matches.length) {
        const entry = matches[0],
          parent = (await entry.getParentRem())?._id;
        if (!parent) throw new TaskError('conflict', 'Index entry lost parent', entry._id);
        j.ids[k] = entry._id;
        j.textPreconditions[k] ??=
          j.createdTextHashes[entry._id] ?? (await contentHash(entry.text));
        await save();
        await this.patch(k, entry._id, j.textPreconditions[k], text, j, save, parent, true);
      } else j.ids[k] = (await this.createPlain(k, p.indexRemId, text, j, save))._id;
      if (!(await r.isCollapsed(p.partitionRemId))) {
        if (j.completed) throw new TaskError('conflict', 'Completed page outline changed', id);
        const current = await this.assertPlain(
          id,
          [p.partitionRemId],
          [await contentHash([pg.title])]
        );
        await this.mutate(() => current.rem.setIsCollapsed(true, p.partitionRemId));
      }
      await save();
    }
    await this.patchAnswers(p.answerPatches ?? [], j, save, receipt);
    const activity = [...j.created, ...j.updated].some((e) =>
      /^(page|node|index|aliases):/.test(e.key)
    );
    if (activity) {
      const text: TextSegment[] = [`${j.batchDate} update ${j.batchKey}: `];
      for (const pg of p.pages) text.push({ remId: j.ids[`page:${pg.key}`] }, ' ');
      j.ids['log:batch'] = (await this.createPlain('log:batch', p.logRemId, text, j, save))._id;
    }
    for (const pg of p.pages) {
      const id = j.ids[`page:${pg.key}`],
        matches = await this.indexEntries(await this.rem(p.indexRemId), id),
        expected = await contentHash(await this.richText([{ remId: id }, ' — ', ...pg.summary], j));
      if (
        matches.length !== 1 ||
        matches[0]._id !== j.ids[`index:${pg.key}`] ||
        (await contentHash(matches[0].text)) !== expected ||
        !(await matches[0].remsBeingReferenced()).some((r) => r._id === id) ||
        !(await this.plain(matches[0]))
      )
        throw new TaskError('incomplete', 'Index unique owner/text/reference proof failed', id);
      await this.assertPlain(id, [p.partitionRemId], [await contentHash([pg.title])]);
      for (const n of pg.nodes)
        await this.assertPlain(
          j.ids[`node:${n.key}`],
          [id],
          [await contentHash(await this.richText(n.text, j))]
        );
      receipt.checks.push({
        kind: 'wikiIndex',
        remId: id,
        status: 'passed',
        expected: { ownerCount: 1 },
        actual: { ownerCount: 1, indexRemId: matches[0]._id },
      });
    }
    const pageIds = p.pages.map((pg) => j.ids[`page:${pg.key}`]),
      verified = await verifyScope(this.deps.plugin, {
        schemaVersion: 1,
        inspect: { schemaVersion: 1, remIds: pageIds, subtreeRootIds: [p.wikiRootId] },
        expectations: [
          { kind: 'powerup', remId: p.wikiRootId, code: 'u', value: true },
          { kind: 'zeroCards', remId: p.wikiRootId },
          ...pageIds.flatMap((remId) => [
            { kind: 'parent' as const, remId, value: p.partitionRemId },
            { kind: 'remType' as const, remId, value: 'text' },
          ]),
        ],
      });
    receipt.checks.push(...verified.checks);
    if (verified.status !== 'passed')
      throw new TaskError('incomplete', 'Complete Wiki verification failed');
    await this.facts(Object.values(j.ids), receipt);
  }
}
