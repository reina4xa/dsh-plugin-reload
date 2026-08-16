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
    // hard reload 需要 internal module loader（--expose-internals 或
    // node-addon-require-builtin）；无 flag 的测试环境跳过 hard 路径断言，
    // 用 soft 模式验证"恰好重启一个 entry"的隔离语义。
    const internal = (ctx.loader as { internal?: unknown }).internal
    const mode = internal ? 'auto' : 'soft'
    const watched: FixtureCounter = { applies: 0, disposes: 0 }
    const other: FixtureCounter = { applies: 0, disposes: 0 }
    ctx.loader.builtins.watched = countingPlugin(watched)
    ctx.loader.builtins.other = countingPlugin(other)
    const watchedId = await ctx.loader.create({ name: 'cordis:watched' })
    await ctx.loader.create({ name: 'cordis:other' })
    expect(watched.applies).toBe(1)
    expect(other.applies).toBe(1)

    const result = await tool.execute({ name: watchedId, mode }, stubExecution) as Record<string, unknown>
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

  it('matches an MCP serverName with _ and - normalized (umetask-http == umetask_http)', async () => {
    const { ctx, tool } = await harness()
    const counter: FixtureCounter = { applies: 0, disposes: 0 }
    ctx.loader.builtins.mcp = countingPlugin(counter)
    const id = await ctx.loader.create({
      name: 'cordis:mcp',
      config: { serverName: 'umetask_http', transport: 'streamable-http' },
    })

    // 连字符写法应命中下划线 serverName（归一化匹配）
    const result = await tool.execute({ name: 'umetask-http', dry_run: true }, stubExecution) as Record<string, unknown>
    expect((result.wouldReload as Record<string, unknown>).entryId).toBe(id)
    expect((result.wouldReload as Record<string, unknown>).serverName).toBe('umetask_http')
  })

  it('prefers the exact-id match over a fuzzy sibling when both would hit', async () => {
    const { ctx, tool } = await harness()
    const counter: FixtureCounter = { applies: 0, disposes: 0 }
    ctx.loader.builtins.mcp = countingPlugin(counter)
    const first = await ctx.loader.create({
      name: 'cordis:mcp',
      config: { serverName: 'umetask', transport: 'stdio' },
    })
    const second = await ctx.loader.create({
      name: 'cordis:mcp',
      config: { serverName: 'umetask_http', transport: 'streamable-http' },
    })

    // "umetask" 精确命中 serverName=umetask（100 档），不会因子串撞上 umetask_http
    const result = await tool.execute({ name: 'umetask', dry_run: true }, stubExecution) as Record<string, unknown>
    expect((result.wouldReload as Record<string, unknown>).entryId).toBe(first)
    void second
  })

  it('matchScore: bare entry id beats the include:-prefixed spelling tier-wise', async () => {
    // 纯函数单测：entry id 带 include: 前缀时，"mcp-umetask" 应命中 90 档
    // （裸 id），而不是落到 60 档子串；精确 module/serverName 仍 100 档优先。
    const { matchScore } = await import('../src/index.ts')
    const summary = {
      entryId: 'include:mcp-umetask',
      module: '@deepseek-ai/dsh-mcp-client',
      serverName: 'umetask',
      phase: 'active',
    }
    expect(matchScore(summary, 'include:mcp-umetask')).toBe(100)   // 精确 entry id
    expect(matchScore(summary, 'mcp-umetask')).toBe(90)            // 裸 id（去前缀）
    expect(matchScore(summary, 'umetask')).toBe(100)               // 精确 serverName
    expect(matchScore(summary, 'umetask_http')).toBe(0)            // 无关
    expect(matchScore(summary, 'mcp')).toBe(60)                    // 子串兜底
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
