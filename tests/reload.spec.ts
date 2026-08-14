import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as PluginReload from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Function plugin fixture counting fiber activations and disposals. */
interface FixtureCounter {
  applies: number
  disposes: number
}

function countingPlugin(counter: FixtureCounter) {
  return (ctx: Context) => {
    ctx.effect(() => {
      counter.applies += 1
      return () => {
        counter.disposes += 1
      }
    }, 'fixture-counter')
  }
}

const stubExecution = {} as ToolRunContext

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(PluginReload)
  const tools = ctx.get('tools') as ToolRuntime
  const tool = tools.get('reload_plugin')
  if (tool === undefined) throw new Error('reload_plugin was not registered')
  return { ctx, fiber, tool, tools }
}

describe('plugin-reload', () => {
  it('exports a namespace plugin without a default export', async () => {
    expect('default' in PluginReload).toBe(false)
    expect(PluginReload.name).toBe('plugin-reload')
    expect(PluginReload.inject).toEqual(['loader', 'tools'])
  })

  it('reloads exactly one entry matched by id and leaves siblings running', async () => {
    const { ctx, tool } = await harness()
    const watched: FixtureCounter = { applies: 0, disposes: 0 }
    const other: FixtureCounter = { applies: 0, disposes: 0 }
    ctx.loader.builtins.watched = countingPlugin(watched)
    ctx.loader.builtins.other = countingPlugin(other)
    const watchedId = await ctx.loader.create({ name: 'cordis:watched' })
    await ctx.loader.create({ name: 'cordis:other' })
    expect(watched.applies).toBe(1)
    expect(other.applies).toBe(1)

    const result = await tool.execute({ name: watchedId }, stubExecution) as Record<string, unknown>
    expect(result.reloaded).toBe(watchedId)
    expect(result.previousPhase).toBe('active')
    expect(result.phase).toBe('active')
    expect(watched.applies).toBe(2)
    expect(watched.disposes).toBe(1)
    expect(other.applies).toBe(1)
    expect(other.disposes).toBe(0)
  })

  it('matches an mcp-client entry by config.serverName', async () => {
    const { ctx, tool } = await harness()
    const counter: FixtureCounter = { applies: 0, disposes: 0 }
    ctx.loader.builtins.mcp = countingPlugin(counter)
    const id = await ctx.loader.create({
      name: 'cordis:mcp',
      config: { serverName: 'umetask', transport: 'stdio' },
    })

    const result = await tool.execute({ name: 'umetask' }, stubExecution) as Record<string, unknown>
    expect(result.reloaded).toBe(id)
    expect(result.serverName).toBe('umetask')
    expect(counter.applies).toBe(2)
  })

  it('previews the match with dry_run without restarting the fiber', async () => {
    const { ctx, tool } = await harness()
    const counter: FixtureCounter = { applies: 0, disposes: 0 }
    ctx.loader.builtins.watched = countingPlugin(counter)
    const id = await ctx.loader.create({ name: 'cordis:watched' })

    const result = await tool.execute({ name: id, dry_run: true }, stubExecution) as Record<string, unknown>
    expect(result.dryRun).toBe(true)
    expect((result.wouldReload as Record<string, unknown>).entryId).toBe(id)
    expect(counter.applies).toBe(1)
    expect(counter.disposes).toBe(0)
  })

  it('fails on an unknown name and lists available entries', async () => {
    const { ctx, tool } = await harness()
    ctx.loader.builtins.watched = countingPlugin({ applies: 0, disposes: 0 })
    const id = await ctx.loader.create({ name: 'cordis:watched' })

    await expect(tool.execute({ name: 'nope' }, stubExecution)).rejects.toThrow(
      /no plugin entry matches "nope"[\s\S]*cordis:watched/,
    )
    expect(id).toBeTruthy()
  })

  it('fails on an ambiguous module name and demands an exact entry id', async () => {
    const { ctx, tool } = await harness()
    ctx.loader.builtins.dup = countingPlugin({ applies: 0, disposes: 0 })
    const first = await ctx.loader.create({ name: 'cordis:dup' })
    const second = await ctx.loader.create({ name: 'cordis:dup' })

    await expect(tool.execute({ name: 'cordis:dup' }, stubExecution)).rejects.toThrow(
      new RegExp(`matches 2 plugin entries[\\s\\S]*${first}[\\s\\S]*${second}`),
    )
  })

  it('does not match group entries', async () => {
    const { ctx, tool } = await harness()
    ctx.loader.builtins.grp = countingPlugin({ applies: 0, disposes: 0 })
    await ctx.loader.create({ name: 'cordis:grp', group: true })

    await expect(tool.execute({ name: 'cordis:grp' }, stubExecution)).rejects.toThrow(
      /no plugin entry matches "cordis:grp"/,
    )
  })

  it('unregisters the tool when the plugin fiber is disposed (HMR safety)', async () => {
    const { fiber, tools } = await harness()
    expect(tools.get('reload_plugin')).toBeDefined()
    await fiber.dispose()
    expect(tools.get('reload_plugin')).toBeUndefined()
  })
})
