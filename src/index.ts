/**
 * Model-facing plugin reload tool: restart exactly one Cordis Loader entry —
 * matched by entry id, module name, or MCP `serverName` — by disposing its
 * fiber and re-applying the plugin. Every other entry keeps running.
 *
 * Namespace plugin (named exports, no default export). Reloading an
 * `mcp-client` entry respawns that MCP server process (fresh code on disk)
 * and re-registers its tools; sibling MCP connections are not affected.
 *
 * @module @deepseek-ai/dsh-host-plugin-reload
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
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
interface ReloadMatch {
  entry: ReloadableEntry
  summary: EntrySummary
}

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
 * Register the `reload_plugin` tool.
 * @param ctx - the plugin context (must inject `loader` and `tools`).
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'reload_plugin',
    description:
      'Restart one Cordis plugin entry by disposing its fiber and re-applying the plugin with unchanged config. '
      + 'Match by exact entry id (preferred), module name, or MCP serverName (for mcp-client entries, e.g. their '
      + 'MCP namespace). Only the matched entry restarts; all other plugins and MCP connections keep running. '
      + 'For an mcp-client entry this respawns the MCP server child process, picking up new server code on disk, '
      + 'and re-registers its tools; tools of the reloaded entry are unavailable for a few seconds during the '
      + 'restart. Group entries cannot be reloaded as a whole — target a leaf entry. Use dry_run to preview the '
      + 'match without restarting.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Entry id, module name, or MCP serverName of the single plugin entry to reload.',
      },
      dry_run: {
        type: 'boolean',
        description: 'When true, only report which entry would reload; do not restart it.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args): Promise<JsonValue> {
      const query = args.name.trim()
      if (!query) throw new Error('reload_plugin: "name" must be a non-empty string')

      const available: EntrySummary[] = []
      const matches: ReloadMatch[] = []
      for (const entry of ctx.loader.entries()) {
        if (entry.options.group) continue
        const summary = summarize(entry as unknown as EntryLike)
        available.push(summary)
        if (entry.id === query || entry.options.name === query || summary.serverName === query) {
          matches.push({ entry, summary })
        }
      }

      if (matches.length === 0) {
        throw new Error(
          `reload_plugin: no plugin entry matches "${query}". Available entries (${available.length}):\n`
          + formatCandidates(available, available.length),
        )
      }
      if (matches.length > 1) {
        throw new Error(
          `reload_plugin: "${query}" matches ${matches.length} plugin entries — re-run with an exact entry id:\n`
          + formatCandidates(matches.map(m => m.summary), matches.length),
        )
      }

      // length 0 and >1 both threw above; exactly one match remains.
      const { entry, summary } = matches[0] as ReloadMatch
      if (args.dry_run === true) {
        return {
          dryRun: true,
          wouldReload: summary,
        } as unknown as JsonValue
      }

      const previousPhase = summary.phase
      if (entry.fiber === undefined) {
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
      return {
        reloaded: reloaded.entryId,
        module: reloaded.module,
        serverName: reloaded.serverName,
        previousPhase,
        phase: reloaded.phase,
        note: 'The entry fiber was disposed and re-applied with unchanged config; only this entry restarted.',
      } as unknown as JsonValue
    },
  }))
}
