# dsh-tavern-input-escape

DSH Tavern 输入转义与防路由插件（参考 `st-4a-guard` 设计并原生适配 DSH Tavern 请求生命周期）。

所有转换仅作用于发往模型的临时请求副本，**不修改 Story Timeline 存档和前端显示气泡中的玩家原文**。

## 核心能力

### 1. 四种输入转义模式
- **一 · JSON `\uXXXX` 整包转义（`json_escape`，默认）**：在 HTTP 发送序列化层将非 ASCII 字符转为标准单斜杠 `\uXXXX` 字面量（支持全包或仅标记本轮用户输入区间）。0 额外 Token、0 模型理解负担，后端 `JSON.parse()` 自动无损还原。
- **二 · 紧凑码点转义（`compact`）**：将本轮玩家输入的汉字与拉丁字母编码为 `⟦U:HEX ...⟧`（保留标签、标点与换行），并附解码说明引导模型理解。
- **三 · 输入转图片（`hybrid_image`）**：使用浏览器 Canvas 将本轮用户输入分页绘制为白底黑字图片（`1024×1024`，带 `[Role: USER] [Part i/N]` 标题），以 DSH 多模态图片附件替代文本发送；不可用或超时时自动回退为紧凑码点转义。
- **四 · 深度破盾（`full_armor`）**：扫描全部非系统消息的高危词库转为 `⟦U:HEX ...⟧`，并叠加本轮用户输入码点转义与整包 `\uXXXX` 传输转义。

### 2. 防路由与分类器清洗
- **动态 Session-ID 指纹**：每次请求注入随机 `[Session-ID: SID_...]` 与随机 `user` / `seed`，打散路由关联。
- **分类器脱敏清洗**：逆向还原注音符号与零宽字符、移除随机 HTML 注释洪流、温和化 `+55 Companion`、`+701 Anti-Distillation` 与 `+419 Jailbreak` 特征词。
- **System 降权合并**：将原有 `system` / `developer` 消息合并降权为 `user` 参考，系统槽位仅保留中立虚构创作头与指纹（自动保护工具调用与思维签名消息）。
- **伪造轮次收敛**：清除反审查诱饵问答轮次，收敛历史记录前的伪造预填 `assistant` 轮次。
- **思考等级与参数兼容**：支持保持原样、正文锁 `low` 或指定 `reasoningEffort`，并在 Gemini 4H/4C 下自动清理冲突采样参数。
- **可选权重稀释垫片**：默认关闭，按需启用 `<inert_lexical_entropy_buffer>` 隔离静物参考垫片。

## 安装与更新

### 方式一：通过 Git 地址一键安装与更新（推荐）
打开 **设置 → DSH Tavern → 插件**，粘贴下方 GitHub 分支地址并点击 **「安装」**：

```text
https://github.com/NikaidouYui/dsh-tavern/tree/plugin-input-escape
```

后续仓库有新提交并由 GitHub Actions 自动打包发布后，只需在插件列表点 **「更新」** 即可拉取最新版本（支持 GitHub 直连与 jsDelivr CDN 自动回退），更新后重启 DSH 并刷新页面生效。

### 方式二：打包 ZIP 上传安装
可从 GitHub Releases 的 `tavern-plugins-current` 下载 `dsh-tavern-input-escape.zip`（或将本目录打包为 ZIP），在 **设置 → DSH Tavern → 插件 → 上传 ZIP** 中上传并重启 DSH。

### 方式三：通过插件目录安装（本地开发 / 手动安装）
将本插件文件夹复制到 Tavern 数据目录的 `plugins/` 下：

- 默认目录：`~/.dsh/profile-data/tavern/data/plugins/dsh-tavern-input-escape/`
- 若设置了 `DSH_HOME`：`$DSH_HOME/profile-data/tavern/data/plugins/dsh-tavern-input-escape/`

复制后重启 DSH，在 **设置 → DSH Tavern → 插件** 中确认状态为「已加载」。
