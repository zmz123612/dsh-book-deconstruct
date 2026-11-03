# dsh-book-deconstruct

DeepSeek Harness **Host 插件**（不是 Agent 预设）：装进 profile 后会出现在插件列表，**任意会话**都可用：

- 斜杠命令：`/book 书名 | 作者`
- 工具：`book_deconstruct`（智能体在对话里调用）

## 安装

从 npm（推荐）：

```sh
dsh plugin --profile desktop add dsh-book-deconstruct
```

从本地目录（开发）：

```sh
dsh plugin --profile desktop add /path/to/book-deconstruct
```

从 GitHub（需公开仓库）：

```sh
dsh plugin --profile desktop add github:OWNER/dsh-book-deconstruct
```

装完后**完全退出并重新打开** DeepSeek Harness。

## 用法

任意预设下的会话均可：

```text
/book 思考，快与慢 | 丹尼尔·卡尼曼
```

输出两段：

1. **故事情节** — 讲清整本书（不是一句话短评，也不灌水）
2. **一段有深度的思考** — 只写一整段


也支持：

```text
/book 《思考，快与慢》丹尼尔·卡尼曼
```

或直接说：「帮我解读《思考，快与慢》，作者丹尼尔·卡尼曼」。

输出只有两部分：把整本书讲透 + 最后一段有深度的思想。不编造不确定的事实、引文、页码。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 按行 id `book-deconstruct` 覆盖：

```yaml
- id: book-deconstruct
  name: dsh-book-deconstruct
  config:
    provider: ''   # 与 model 成对；空则用默认模型
    model: ''
    temperature: 0.5
    maxTokens: 8000
```

## Topics（上架市场）

公开 GitHub 仓库后请添加 Topics：`dsh-plugin`、`deepseek-harness`。也可在 [DSH Marketplace](https://dshmarketplace.dev/submit) 提交仓库。
