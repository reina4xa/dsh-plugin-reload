# dsh-plugin-reload

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，为模型提供 **`reload_plugin` 工具**：按 entry id、模块名或 MCP `serverName` 匹配，恰好重启一个 Cordis Loader 条目。其余条目全部保持运行。

按条目类型选择两种重载策略：

- **`mcp-client` 条目**：重启时拉起 MCP server 子进程（拾取磁盘上的新代码）并重新注册其工具；同族的其他 MCP 连接不受影响。
- **进程内插件条目**：执行**硬重载**——爆破该条目及其本地源码文件的 Node ESM/CJS 模块缓存，从磁盘重新 import，并把条目的 fiber 换到新模块上（与 `cordis-plugin-hmr` 部分重载同款技术）。插件代码改动**无需重启 host 即可生效**；重新 import 或重新 apply 失败时自动回滚到旧代码。

> 构建在 DeepSeek Harness 的"一切皆插件"架构之上。官方仓库当前不接受外部 PR——按照 [CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/CONTRIBUTING.md) 的建议，社区插件独立发布并通过 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题分享。

## 安装（自动挂载）

自 **v0.1.2** 起本包声明了 `dsh.bundle`，一条命令即可完成安装**并自动挂载**：

```sh
dsh plugin --profile web add dsh-plugin-reload
```

底层发生的事情：

1. `dsh plugin` 在 profile 目录（`~/.dsh/profiles/<name>/`）里执行 `pnpm add`。
2. 成功后对账 profile 清单：因为 `dsh-plugin-reload` 的 `package.json` 声明了 `dsh.bundle`，它会被自动追加到 profile 的 `dsh.profile.bundles` 层列表。
3. 下次启动 harness 时组合 bundle 层，插件自带的 `cordis.patch.yml` 自动插入 `plugin-reload` 条目——模型工具列表中出现该工具，**无需手动编辑 patch**。

升级到后续版本：

```sh
dsh plugin --profile web update dsh-plugin-reload
```

> 刚发布的新版本可能被 pnpm 的 `minimumReleaseAge` 供应链策略短暂拦截；用显式版本号（`dsh plugin --profile web add dsh-plugin-reload@0.1.x`）可绕过。

## 手动挂载（备选）

如果用普通 `npm` 安装（而非 `dsh plugin`），或希望用显式 patch 行，请加入 profile patch（`~/.dsh/profiles/<name>/cordis.patch.yml`，或 `--patch` 覆盖层）：

```yaml
- insert:
    - id: plugin-reload
      name: 'dsh-plugin-reload'
```

重启 harness（或让 profile-patch HMR 热载）。bundle 挂载与手动行**二选一**，不要同时保留（重复注册同名工具会在加载时失败）。

## 用法

`reload_plugin` 接受：

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `name` | 是 | 待重载条目的 entry id（首选）、模块名或 MCP `config.serverName` |
| `mode` | 否 | `auto`（默认）——进程内插件硬重载、mcp-client 走 fiber 重启；`soft`——仅 dispose 后重新 apply（进程内代码改动不生效）；`hard`——爆破 ESM/CJS 缓存并从磁盘重新 import 条目代码 |
| `dry_run` | 否 | `true` 时只报告匹配到的单个条目及将采用的策略，不重启 |

匹配在一次遍历 Loader 非 group 条目时完成：先精确 entry id，再模块名，再 mcp-client `serverName`。零匹配时以受限长度的可用条目列表报错；多匹配时列出候选 entry id 且不做任何更改。group 条目永不匹配——重载整棵子树需逐叶条目调用。

成功重载返回条目 id、module、可选 `serverName`、前后 fiber 阶段、所用策略及语义说明。硬重载不会写回 loader 配置：条目的 options 保持不变，仅把 fiber 换到重新 import 的模块上。

## 依赖要求

- 一个包含 web（或 headless）bundle 的 DeepSeek Harness profile，即标准 `dsh` 运行时，且具备 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis-plugin-loader`。

## 已知限制

- **重载期间工具短暂不可用** —— 被重载条目（如 MCP 工具）在 dispose 与重新 apply 之间被注销，进行中的调用会失败。
- **不支持 group 重载** —— 重载整棵插件子树必须逐叶条目调用。
- **硬重载只覆盖插件自身代码** —— `node_modules` 里的依赖（如 `@deepseek-ai/*`、`ws`）刻意不重新 import；改这些仍需重启 host。被重载插件的模块顶层状态会重新求值（全新 `import`），插件不能依赖顶层持久状态跨重载保留。
- **仅面向模型** —— 无浏览器/UI 界面；Settings 的插件清单页保持只读。

## 开发

```sh
npm install        # 安装 dev 依赖（类型 + typescript）自 npm
npm run build      # tsc → lib/
npm test           # vitest
npm pack           # 发布前检查 tarball 内容
```

## License

MIT
