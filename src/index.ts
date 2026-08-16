/**
 * Model-facing plugin reload tool: restart exactly one Cordis Loader entry —
 * matched by entry id, module name, or MCP `serverName`. Every other entry
 * keeps running.
 *
 * Reload strategy per entry kind:
 * - `mcp-client` entries (config carries `serverName`): dispose the fiber and
 *   re-apply the plugin; the mcp-client apply respawns the MCP server child
 *   process, so fresh server code on disk is picked up.
 * - in-process plugin entries: hard reload — bust the Node ESM/CJS module
 *   caches for the entry module and its local (non-external) dependencies,
 *   re-import fresh code from disk, and swap the entry's fibers onto the new
 *   module. This is the same technique `cordis-plugin-hmr`'s `partialReload`
 *   uses, so in-process plugin code changes take effect without a host
 *   restart. A failed re-import or re-apply rolls back to the previous module
 *   and fibers, and the caches are restored.
 *
 * `fiber.restart()` alone cannot pick up in-process code changes: Node's ESM
 * module map is keyed by URL, and re-importing the same specifier returns the
 * cached module, so the old code keeps running (this was the pre-0.2 behavior
 * for every in-process entry).
 *
 * @module @deepseek-ai/dsh-host-plugin-reload
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {
  Entry,
  ModuleJob,
  ModuleLoader,
  ResolveResult,
} from '@deepseek-ai/cordis-plugin-loader'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'plugin-reload'

/** Services required by this plugin. */
export const inject = ['loader', 'tools']

/** Cap on entry listings embedded in tool results and error messages. */
const MAX_LISTED_ENTRIES = 20

/**
 * Runtime mirror of the cordis FiberState const enum (numeric values cross
 * package boundaries, so the mapping is restated locally).
 */
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
} as const

/** One reload candidate or outcome, projected for the model. */
interface EntrySummary {
  entryId: string
  module: string
  serverName?: string
  phase: string
}

/** Minimal structural shape of a Loader entry as consumed here. */
interface EntryLike {
  id: string
  options: { name?: string; config?: unknown; group?: boolean | null }
  fiber?: { state: number } | undefined
}

/** Structural view of the Loader entry lifecycle surface this plugin acts on. */
interface ReloadableEntry extends EntryLike {
  disabled: boolean
  fiber?: { state: number; restart(): Promise<void> } | undefined
  refresh(): Promise<void>
}

/** One matched entry paired with its projected summary. */
/** Reload strategy requested or applied. */
type ReloadMode = 'auto' | 'soft' | 'hard'
type ReloadStrategy = 'soft' | 'hard'

/** Read the current fiber phase of one entry as a stable string. */
function phaseOf(entry: EntryLike): string {
  const state = entry.fiber?.state
  if (state === undefined) return 'not-loaded'
  return FIBER_PHASE[state as keyof typeof FIBER_PHASE]
}

/** Extract the MCP serverName when the entry is an mcp-client instance. */
function serverNameOf(entry: EntryLike): string | undefined {
  const config = entry.options.config
  if (config === null || typeof config !== 'object') return undefined
  const serverName = (config as Record<string, unknown>).serverName
  return typeof serverName === 'string' ? serverName : undefined
}

/** Project one entry for tool output. */
function summarize(entry: EntryLike): EntrySummary {
  const summary: EntrySummary = {
    entryId: entry.id,
    module: entry.options.name ?? '<unknown>',
    phase: phaseOf(entry),
  }
  const serverName = serverNameOf(entry)
  if (serverName !== undefined) summary.serverName = serverName
  return summary
}

/** Render a bounded candidate list for error messages. */
function formatCandidates(entries: EntrySummary[], total: number): string {
  const listed = entries.slice(0, MAX_LISTED_ENTRIES)
  const lines = listed.map(e => `- ${e.entryId} (module: ${e.module}${e.serverName ? `, serverName: ${e.serverName}` : ''}, phase: ${e.phase})`)
  if (total > listed.length) lines.push(`- ... and ${total - listed.length} more`)
  return lines.join('\n')
}

/**
 * Normalize a matching key: lowercase and treat `_`/`-`/`.` as equivalent
 * separators, so `umetask_http`, `umetask-http` and `umetask.http` all
 * address the same MCP serverName.
 */
function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[-_.]+/g, '-')
}

/** Strip the loader group prefix (`include:`, `cordis:`, …) off an entry id. */
function bareId(id: string): string {
  const idx = id.indexOf(':')
  return idx === -1 ? id : id.slice(idx + 1)
}

/** Last path segment of a module name (`@scope/pkg` → `pkg`). */
function bareModule(name: string): string {
  const idx = name.lastIndexOf('/')
  return idx === -1 ? name : name.slice(idx + 1)
}

/**
 * Match strength of one entry against a query. 0 = no match; larger is more
 * precise. Tiers (exact wins over fuzzy, so `mcp-umetask` targets the
 * `include:`-prefixed entry instead of also hitting the `-http` sibling):
 *   100 — exact entry id / module name / serverName
 *    90 — bare entry id (group prefix stripped)
 *    80 — normalized serverName / bare module name
 *    60 — substring (≥3 chars to stay useful)
 */
/** Exported for unit testing; internal matching logic lives here. */
export function matchScore(entry: EntrySummary, query: string): number {
  const q = query.trim()
  if (!q) return 0
  const normQ = normalizeKey(q)
  const serverName = entry.serverName
  if (entry.entryId === q || entry.module === q || (serverName !== undefined && serverName === q)) {
    return 100
  }
  if (bareId(entry.entryId) === q) return 90
  if (serverName !== undefined && normalizeKey(serverName) === normQ) return 80
  if (bareModule(entry.module) === q) return 80
  if (q.length >= 3) {
    const normId = normalizeKey(entry.entryId)
    const normModule = normalizeKey(entry.module)
    if (normId.includes(normQ) || normModule.includes(normQ)
        || (serverName !== undefined && normalizeKey(serverName).includes(normQ))) {
      return 60
    }
  }
  return 0
}

/** Render the "no match" hint: what the caller could pass instead. */
function noMatchHint(query: string): string {
  return `reload_plugin: no plugin entry matches "${query}". `
    + 'Try an entry id (with or without the "include:" prefix), a module name, '
    + 'or an MCP serverName (e.g. "umetask_http"; "_" and "-" are equivalent). '
    + 'Use dry_run=true to preview.'
}

/**
 * Pick the reload strategy for one entry.
 *
 * mcp-client entries always reload through a fiber restart — the child
 * process respawn IS the code reload, and a module swap would only reload the
 * wrapper plugin (whose code lives in the host bundle). In-process plugin
 * entries hard-reload by default so code changes actually take effect.
 */
function reloadStrategy(entry: EntryLike, mode: ReloadMode): ReloadStrategy {
  if (mode === 'soft') return 'soft'
  return serverNameOf(entry) !== undefined ? 'soft' : 'hard'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Node's internal ESM `loadCache` differs across versions (plain Map on
 * 22/23; slot-typed LoadCache on 24+ where `.delete` only nulls the slot).
 * `Map.prototype` methods remove the entry entirely on both shapes. These
 * helpers deliberately treat the cache as an untyped Map.
 */
const cacheGet = (cache: unknown, url: string): unknown =>
  (Map.prototype.get as (this: unknown, key: string) => unknown).call(cache, url)
const cacheSet = (cache: unknown, url: string, value: unknown): void => {
  ;(Map.prototype.set as (this: unknown, key: string, value: unknown) => unknown).call(cache, url, value)
}
const cacheDelete = (cache: unknown, url: string): void => {
  ;(Map.prototype.delete as (this: unknown, key: string) => unknown).call(cache, url)
}

/**
 * Extract the ModuleJob for a URL from the internal loadCache, across loader
 * shapes: Node 22/23 stores the job directly, while Node 24+ stores a
 * `{ [type]: ModuleJob }` slot object per URL (type e.g. `'javascript'`).
 */
function moduleJobOf(slot: unknown): ModuleJob | undefined {
  if (slot === undefined || slot === null || typeof slot !== 'object') return undefined
  const record = slot as Record<string, unknown>
  if ('linked' in record || 'url' in record) return slot as ModuleJob
  const candidate = record.javascript ?? record.commonjs ?? record.module
    ?? Object.values(record)[0]
  return candidate as ModuleJob | undefined
}

/** Resolve a module specifier to its file URL (Node 22/23 vs 24+ loader shapes). */
async function resolveEntryUrl(internal: ModuleLoader, specifier: string, parentURL: string): Promise<string> {
  if (internal.version === 'v2') {
    return internal.resolveSync(parentURL, { specifier, attributes: {} }).url
  }
  const result: ResolveResult = await internal.resolve(specifier, parentURL, {})
  return result.url
}

/**
 * Directory of the package owning a module URL — the nearest
 * `node_modules/<name>` boundary, with scoped names (`@scope/pkg`) handled.
 */
function packageRootOf(url: string): string | undefined {
  const marker = '/node_modules/'
  const idx = url.lastIndexOf(marker)
  if (idx === -1) return undefined
  const head = url.slice(0, idx + marker.length)
  const segments = url.slice(idx + marker.length).split('/')
  const nameLength = segments[0].startsWith('@') && segments.length > 1
    ? segments[0].length + 1 + segments[1].length
    : segments[0].length
  return head + url.slice(idx + marker.length, idx + marker.length + nameLength)
}

/**
 * Collect the module graph that must be re-evaluated together with the entry:
 * the entry file plus everything under its own package (local source files),
 * skipping `node:` builtins and other `node_modules` packages (dependencies
 * of the plugin never change with the plugin's own code).
 */
async function collectLocalModules(
  internal: ModuleLoader,
  entryUrl: string,
  packageRoot: string | undefined,
): Promise<string[]> {
  const loadCache = internal.loadCache
  const files = new Set<string>()
  const seen = new Set<string>()
  const walk = async (url: string): Promise<void> => {
    if (seen.has(url)) return
    seen.add(url)
    if (url.startsWith('node:')) return
    // Only the plugin's own files are reloaded. When the entry lives inside a
    // package (its URL has a node_modules/<name> boundary), keep everything
    // under that package root and drop the rest — dependencies resolve to
    // arbitrary paths (e.g. a host checkout) and must never be busted. For a
    // source-tree entry (no node_modules boundary) drop any node_modules
    // children, mirroring cordis-plugin-hmr's dependency walk.
    if (packageRoot !== undefined) {
      if (!url.startsWith(packageRoot)) return
    } else if (url.includes('/node_modules/')) {
      return
    }
    files.add(url)
    const job = moduleJobOf(cacheGet(loadCache, url))
    if (!job) return
    const children = await job.linked
    await Promise.all(Array.from(children, child => walk(child.url)))
  }
  await walk(entryUrl)
  return [...files]
}

/** Fiber with a guaranteed runtime, as produced by `registry.plugin()`. */
interface ReloadFiber extends Fiber {
  runtime: NonNullable<Fiber['runtime']>
}

/**
 * Hard-reload one in-process plugin entry: bust the ESM/CJS module caches for
 * the entry and its local dependencies, re-import fresh code from disk, then
 * swap the entry's fibers onto the fresh module. On any failure the previous
 * module and fibers are restored.
 */
async function hardReloadEntry(entry: Entry, ctx: Context): Promise<void> {
  const loader = ctx.loader
  const internal = loader.internal
  if (!internal) {
    throw new Error(
      'reload_plugin: hard reload needs internal module loader access '
      + '(--expose-internals or node-addon-require-builtin)',
    )
  }
  const name = entry.options.name
  if (!name || name.startsWith('cordis:')) {
    throw new Error(`reload_plugin: entry "${entry.id}" has no reloadable module name`)
  }
  const baseUrl = entry.parent.tree.ctx.baseUrl
  if (!baseUrl) {
    throw new Error(`reload_plugin: cannot resolve base URL for entry "${entry.id}"`)
  }

  // 1. Resolve the entry module's file URL (same specifier/base the tree used).
  let entryUrl: string
  try {
    entryUrl = await resolveEntryUrl(internal, name, baseUrl)
  } catch (error) {
    throw new Error(`reload_plugin: cannot resolve module "${name}": ${messageOf(error)}`)
  }

  // 2. Collect the entry plus its local dependencies.
  const packageRoot = packageRootOf(entryUrl)
  const files = await collectLocalModules(internal, entryUrl, packageRoot)

  // 3. Backup and clear the ESM loadCache and CJS require.cache for those
  //    files. The Map.prototype helpers bypass Node 24+'s slot-only delete.
  const require = createRequire(import.meta.url)
  const loadCache = internal.loadCache
  const esmBackup = new Map<string, unknown>()
  const cjsBackup = new Map<string, NodeModule>()
  for (const url of files) {
    const job = cacheGet(loadCache, url)
    if (job !== undefined) {
      esmBackup.set(url, job)
      cacheDelete(loadCache, url)
    }
    try {
      const filepath = fileURLToPath(url)
      if (require.cache[filepath]) {
        cjsBackup.set(filepath, require.cache[filepath])
        delete require.cache[filepath]
      }
    } catch {
      // not a file: URL — nothing to clear in the CJS cache
    }
  }
  const rollbackCaches = (): void => {
    for (const [url, job] of esmBackup) cacheSet(loadCache, url, job)
    for (const [filepath, module] of cjsBackup) require.cache[filepath] = module
  }

  // 4. Re-import fresh code from disk.
  let fresh: unknown
  try {
    fresh = loader.unwrapExports(await loader.import(entryUrl, undefined))
  } catch (error) {
    rollbackCaches()
    throw new Error(`reload_plugin: re-import of "${name}" failed (caches restored): ${messageOf(error)}`)
  }

  // 5. Swap the entry's fibers onto the fresh module.
  const oldFiber = entry.fiber as ReloadFiber | undefined
  if (oldFiber === undefined) {
    // Fiber never started: the cache is already busted, so a fresh init
    // imports the new code.
    try {
      await entry.refresh()
    } catch (error) {
      rollbackCaches()
      throw new Error(`reload_plugin: init of "${name}" after cache clear failed (caches restored): ${messageOf(error)}`)
    }
    return
  }
  if (!oldFiber.runtime) {
    rollbackCaches()
    throw new Error(`reload_plugin: entry "${entry.id}" has no runtime to swap`)
  }
  const oldRuntime = oldFiber.runtime
  const oldPlugin = oldRuntime.callback
  const oldFibers = [...oldRuntime.fibers]
  if (oldFibers.length === 0) {
    rollbackCaches()
    throw new Error(`reload_plugin: entry "${entry.id}" has no live fibers to swap`)
  }

  try {
    // Dispose old fibers (runs their cleanup) before starting fresh ones.
    await Promise.all(oldFibers.map(fiber => fiber.dispose()))

    // Start fresh fibers on the same contexts, reusing each old fiber's
    // config; re-point the entry so future updates target the new fiber.
    const created: Fiber[] = []
    for (const old of oldFibers) {
      const fiber = old.parent.registry.plugin(fresh as never, old._config, undefined) as Fiber
      fiber.entry = old.entry
      if (fiber.entry) fiber.entry.fiber = fiber
      created.push(fiber)
    }
    // Surface new-fiber load failures so they roll back below.
    await Promise.all(created.map(fiber => fiber.await()))
  } catch (error) {
    // Rollback: dispose fresh fibers, re-register the old plugin, restore caches.
    try {
      const removed = ctx.registry.delete(fresh as never)
      if (removed) await Promise.all([...removed.fibers].map(fiber => fiber.dispose()))
    } catch {
      // rollback disposal failures are best-effort
    }
    await Promise.allSettled(oldFibers.map(fiber => fiber.dispose()))
    for (const old of oldFibers) {
      const fiber = old.parent.registry.plugin(oldPlugin as never, old._config, undefined) as Fiber
      fiber.entry = old.entry
      if (fiber.entry) fiber.entry.fiber = fiber
    }
    rollbackCaches()
    throw new Error(`reload_plugin: hard reload of "${name}" failed (old code restored): ${messageOf(error)}`)
  }
}

/**
 * Register the `reload_plugin` tool.
 * @param ctx - the plugin context (must inject `loader` and `tools`).
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'reload_plugin',
    description:
      'Restart one Cordis plugin entry. Matching is flexible: an exact entry id, module name, or MCP serverName '
      + 'wins; otherwise a bare entry id (with the "include:" prefix stripped), a normalized serverName '
      + '(`_`/`-` equivalent, e.g. "umetask_http" == "umetask-http"), or a ≥3-char substring also matches. '
      + 'If several entries match at the same precision the call fails with the candidates listed — pass an '
      + 'exact id/serverName to disambiguate. Only the matched entry restarts; all other plugins and MCP '
      + 'connections keep running. For an mcp-client entry this respawns the MCP server child process, picking '
      + 'up new server code on disk, and re-registers its tools; tools of the reloaded entry are unavailable for '
      + 'a few seconds. For an in-process plugin entry this hard-reloads its code: the ESM/CJS module caches are '
      + 'busted and the entry is re-imported from disk, so plugin code changes take effect without restarting the '
      + 'host (a failed reload rolls back to the previous code). Group entries cannot be reloaded as a whole — '
      + 'target a leaf entry. Use dry_run to preview the match and strategy without restarting.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Entry id (with or without "include:" prefix), module name, or MCP serverName of the single plugin entry to reload.',
      },
      mode: {
        type: 'string',
        enum: ['auto', 'soft', 'hard'],
        description: 'Reload strategy. auto (default): hard reload for in-process plugins, fiber restart for '
          + 'mcp-client entries; soft: dispose and re-apply only (never picks up in-process code changes); '
          + 'hard: bust ESM/CJS module caches and re-import the entry code from disk.',
      },
      dry_run: {
        type: 'boolean',
        description: 'When true, only report which entry would reload (and with which strategy); do not restart it.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args): Promise<JsonValue> {
      const query = args.name.trim()
      if (!query) throw new Error('reload_plugin: "name" must be a non-empty string')
      const mode: ReloadMode = args.mode ?? 'auto'

      const available: EntrySummary[] = []
      // 按匹配强度排序的候选：同一强度内若有多个命中 → 歧义报错
      const scored: Array<{ entry: ReloadableEntry; summary: EntrySummary; score: number }> = []
      for (const entry of ctx.loader.entries()) {
        if (entry.options.group) continue
        const summary = summarize(entry as unknown as EntryLike)
        available.push(summary)
        const score = matchScore(summary, query)
        if (score > 0) scored.push({ entry, summary, score })
      }

      if (scored.length === 0) {
        throw new Error(
          noMatchHint(query) + ` Available entries (${available.length}):\n`
          + formatCandidates(available, available.length),
        )
      }
      // 最高强度分；同分多个 → 歧义，要求更精确的 id / serverName
      const bestScore = Math.max(...scored.map(m => m.score))
      const best = scored.filter(m => m.score === bestScore)
      if (best.length > 1) {
        throw new Error(
          `reload_plugin: "${query}" matches ${best.length} plugin entries at the same precision `
          + `— re-run with an exact entry id or an MCP serverName:\n`
          + formatCandidates(best.map(m => m.summary), best.length),
        )
      }

      const { entry, summary } = best[0] as { entry: ReloadableEntry; summary: EntrySummary }
      const strategy = reloadStrategy(entry, mode)
      if (args.dry_run === true) {
        return {
          dryRun: true,
          wouldReload: summary,
          strategy,
        } as unknown as JsonValue
      }

      const previousPhase = summary.phase
      if (strategy === 'hard') {
        await hardReloadEntry(entry as unknown as Entry, ctx)
      } else if (entry.fiber === undefined) {
        // Enabled entries whose fiber never started (e.g. failed import) get a
        // fresh init; disabled entries stay untouched by design.
        if (entry.disabled) {
          throw new Error(
            `reload_plugin: entry "${entry.id}" is disabled — enable it in the loader config instead of reloading`,
          )
        }
        await entry.refresh()
      } else {
        // Fiber.restart(): dispose and immediately reload with current config;
        // no options diff and no persistence write involved.
        await entry.fiber.restart()
      }
      const reloaded = summarize(entry as unknown as EntryLike)
      // serverName only exists for mcp-client entries; an undefined value in
      // the returned object is not lossless JSON and would fail validation.
      const result: Record<string, unknown> = {
        reloaded: reloaded.entryId,
        module: reloaded.module,
        previousPhase,
        phase: reloaded.phase,
        strategy,
        note: strategy === 'hard'
          ? 'Module caches were busted and the entry was re-imported from disk (fresh code); only this entry restarted.'
          : 'The entry fiber was disposed and re-applied with unchanged config; only this entry restarted.',
      }
      if (reloaded.serverName !== undefined) result.serverName = reloaded.serverName
      return result as unknown as JsonValue
    },
  }))
}
