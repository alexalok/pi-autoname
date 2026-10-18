# Pi 版本兼容性与影响分析

> 记录本扩展实际采用的宿主接口与验证边界，不能仅凭版本号或导入成功认定完整兼容。

## 当前验证基线

- 本机 Pi / pi-ai：`1.3.0`；Node.js：`22.22.3`。
- pi-autoname：`0.6.8` 加本次未发布修复；扩展版本独立于 Pi 版本。
- Pi 在运行时提供对等依赖，项目没有额外开发依赖。
- 历史适配基线为 Pi `0.80.10`；本次已在 `1.3.0` 做离线宿主验证，没有重新运行旧版宿主，不声称所有旧版本通过。

## 模型调用与认证

命名统一调用 `ctx.modelRegistry.streamSimple(model, context, options).result()`。由宿主解析当前 provider、认证、请求 headers（请求头）、env（环境）与认证返回的 baseUrl（服务地址），扩展只传递命名上下文、输出 token 上限和取消信号。

不再从 `@earendil-works/pi-ai/compat` 调用全局 `complete()`，也不再手动提取凭据或要求 `apiKey` 非空。Pi 的合法认证结果可以没有 Key，例如原生无 Key provider；是否授权及如何发送请求由 Pi 模型运行时判断。认证失败仍进入既有模型回退链，全部失败时尝试安全的本地降级名称。

虚拟模型路由、物理模型选择和思考参数转换也由 Pi 的 `streamSimple()` 处理；扩展不维护另一套路由。取消信号通过 Node.js 原生 `AbortSignal.any()` 合并，不再手工注册及清理父信号监听器。

配置模型继续通过 `ctx.modelRegistry.find()` 解析；回退顺序仍为配置主模型、配置回退模型、会话模型，按 provider/modelId 去重。

## 生命周期与命名契约

| Pi 接口或事件 | 本项目行为 |
|---|---|
| `session_start` | 从当前分支的命名 marker（标记）恢复状态与冷却时间 |
| `agent_settled` | 后台考虑首次或周期命名，不阻塞主代理收口 |
| `session_info_changed` | 立即识别手工 `/name` 变更 |
| `session_shutdown` | 取消未完成请求并拒绝迟到结果 |
| `setSessionName()` / `getSessionName()` | 读写会话名称 |
| `appendEntry()` | 保存命名状态，不进入命名对话 |

自动与 `/autoname` 共享命名核心。单次模型尝试在 12 秒时发出取消信号，所有模型共用 30 秒预算；宿主认证也处于该尝试的取消信号范围。这是协作式取消，依赖宿主及 provider 响应 AbortSignal；若第三方实现忽略取消，不能保证硬性截止。标题仍适用时不重复改写。`respectManualName: true` 保持手工名称，直到显式运行 `/autoname`。

## 隐私边界

发送前先对当前标题和每条对话文本脱敏，再截取每条最多 700 个字符。新增带引号的 JSON 字段识别，包括 `api_key`、`token`、`secret`、`password` 和以 KEY / TOKEN / SECRET / PASSWORD 结尾的字段；完整处理字符串中的空格、转义引号和反斜杠。检测到敏感内容的用户消息不作为本地降级标题来源。

这是常见模式匹配，不保证覆盖所有敏感数据或编码形式。自定义消息功能不属于本次修复，主干仍忽略 `custom_message`；PR #8 未纳入。

## 可复验检查与覆盖

```bash
npm test
PI_HOST_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent" node tests/pi-host-smoke.mjs
```

- `npm test`：纯函数、命名控制器和真实扩展入口的集成测试；模型运行时由测试替代，检查最终请求与名称／marker 写入。
- 宿主检查：使用已安装 Pi `1.3.0` 的加载器、ExtensionRunner、SessionManager.inMemory、ModelRuntime、ModelRegistry 和官方 faux provider（离线测试模型）。验证无 Key 自动命名、虚拟模型原生路由、`/autoname`、重新加载后的状态恢复、最终请求脱敏、模型失败降级，以及敏感文本不得作为降级标题。
- 检查使用临时 HOME、内存凭据与会话，不读取真实凭据，不调用外部模型，不修改个人 Pi 配置；临时 HOME 在结束后清理。
- 未覆盖：真实外部模型、OAuth 登录／刷新、实际交互终端的 `/reload` 操作。宿主重新加载检查不等同于终端人工验收。

## 版本记录

| 日期 | Pi 基线 | 变更 |
|---|---|---|
| 2026-10-19 | `1.3.0` | 使用宿主模型调用，修复无 Key 限制和 JSON 凭据脱敏，补入口集成与离线宿主验证 |
| 2026-07-18 | `0.80.10` | 对齐生命周期与当时的 compat 兼容入口；该调用路径现已替换 |
| 2026-06-09 | 发布版 | 初版兼容性记录 |
