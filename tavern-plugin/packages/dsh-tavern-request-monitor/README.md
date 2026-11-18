# dsh-tavern-request-monitor

DSH Tavern 真实外发请求监控插件：从 Node 底层 HTTP Wire（`undici` `diagnostics_channel`）与 Tavern 请求链路实时捕获每次真实发往模型服务商的请求，并以人类友好的结构化方式呈现。

## 核心能力

- **真实 Wire 级捕获**：位于所有请求改写插件（如 `dsh-tavern-input-escape`）、工具协议增强与 `\uXXXX` 线缆转义、400 降级重试之后捕获真正通过 Socket 发出的 JSON 载荷与 HTTP 状态、首包延迟（TTFB）、总耗时。
- **Tavern 上下文自动关联**：通过只读 `requestRewriter` 关联每条请求的 `gameId`、轮次（`turn`）与用途（前台正文 / 后台结算 / 上下文压缩 / 卡片工作台 / 插件子代理），且绝不修改原请求。
- **人类友好精读界面**（侧栏面板 + 全屏 Overlay 监控台 + 输入栏快捷按钮）：
  - **对话阅读**：按 System / User / Assistant / Tool 角色分卡片，显示字符数、估算 Token 与结构标签摘要；长文本自动折叠；支持页内关键词检索高亮。
  - **转义还原对照**：自动识别 Wire `\uXXXX` 转义与 `⟦U:...⟧` 紧凑码点，默认展示可阅读文本，并支持一键切换查看原始转义形式。
  - **多模态图片与工具可视化**：Base64 / URL 图片直接渲染缩略图与点击放大预览；Thinking、Tool Call、Tool Result 独立结构化折叠呈现。
  - **参数、HTTP 与导出**：查看模型采样参数、工具 Schema、已脱敏的请求头 / 响应头与错误正文；支持一键复制 Markdown 报告、美化 JSON 或脱敏 cURL。
- **安全与内存边界**：自动脱敏 `Authorization`、`x-api-key`、`Cookie` 与 URL Query Key；内存采用条数与总字节双重有界环形缓冲区。

## 安装

### 方式一：本地目录安装
将本目录复制到 Tavern 数据目录的 `plugins/` 下：

- 默认目录：`~/.dsh/profile-data/tavern/data/plugins/dsh-tavern-request-monitor/`
- 若设置了 `DSH_HOME`：`$DSH_HOME/profile-data/tavern/data/plugins/dsh-tavern-request-monitor/`

复制后重启 DSH 并刷新页面，在 **设置 → DSH Tavern → 插件** 中确认状态为「已加载」。

### 方式二：打包 ZIP 上传安装
将本目录打包为 ZIP 后，在 **设置 → DSH Tavern → 插件 → 上传 ZIP** 中上传并重启 DSH。
