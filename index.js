/**
 * book-deconstruct — 输入书名 + 作者，直接输出成品级书籍解读。
 *
 * 输出只保留两部分：
 *   1. 书籍的故事情节（讲清整本书，不要一句话短评，也不要灌水）
 *   2. 一段有深度的思考（最后只写一段，不列条目）
 *
 * 约束：
 *   1. 保留用户原问题（不替换、不改写原文）
 *   2. 同会话每次提问都重新调 dsh-plugin-book-deconstruct 工具；书名/作者重复也一样
 *
 * 入口：
 *   - `/dsh-plugin-book-deconstruct …`：立刻回执；把原问题投入会话；强制调工具
 *   - 自然语言（解读/帮我拆解…）：保留原话，追加强制调工具提示
 *   - `dsh-plugin-book-deconstruct` 工具：真正执行解读
 */

import { randomUUID } from 'node:crypto';

export const inject = ['llm', 'commands', 'tools', 'agents'];

const DEFAULT_TEMPERATURE = 0.5;
const DEFAULT_MAX_TOKENS = 8000;
const TOOL_NAME = 'dsh-plugin-book-deconstruct';
const STEER_PREFIX = `必须调用 ${TOOL_NAME} 工具`;

const USAGE = [
  `用法：/${TOOL_NAME} 书名 | 作者`,
  `示例：/${TOOL_NAME} 思考，快与慢 | 丹尼尔·卡尼曼`,
  `也支持：/${TOOL_NAME} 《思考，快与慢》丹尼尔·卡尼曼`,
  `或：/${TOOL_NAME} 帮我解读《思考，快与慢》，作者丹尼尔·卡尼曼`,
  '也可直接说：帮我解读《思考，快与慢》，作者丹尼尔·卡尼曼',
].join('\n');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let provider = typeof source.provider === 'string' ? source.provider.trim() : '';
  let model = typeof source.model === 'string' ? source.model.trim() : '';
  if ((provider === '') !== (model === '')) {
    provider = '';
    model = '';
  }
  return {
    provider,
    model,
    temperature: clampNumber(source.temperature, 0, 2, DEFAULT_TEMPERATURE),
    maxTokens: clampInt(source.maxTokens, 256, 32000, DEFAULT_MAX_TOKENS),
  };
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

/** 去掉首尾空白、首尾书名号/引号，并压平换行。 */
function cleanField(value, maxLength) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  const stripped = flat
    .replace(/^[《「『"'“”]+/u, '')
    .replace(/[》」』"'“”]+$/u, '')
    .trim();
  return stripped.slice(0, maxLength);
}

/** 去掉作者字段前的分隔符与「作者/by」前缀。 */
function cleanAuthorTail(value) {
  let author = String(value ?? '').trim();
  author = author.replace(/^[\s|｜/—\-–—,，、:;：]+/u, '').trim();
  author = author.replace(/^(?:作者(?:是)?|by)\s*[：:：]?\s*/iu, '').trim();
  return author;
}

const INTENT_PREFIX =
  /^(?:请?帮?我?)?(?:解读|拆解|总结|分析|讲讲|讲一下)(?:一下)?\s*/iu;

/** 斜杠 followup 防去重标记；解析前剥离，不污染书名/作者。 */
const REQUEST_MARK_RE = /\n?［请求:[^］]+］\s*$/u;

function hasBookIntent(text) {
  return /(?:解读|拆解|总结|分析|讲讲|讲一下)/u.test(text);
}

function stripRequestMark(text) {
  return text.replace(REQUEST_MARK_RE, '').trim();
}

/**
 * 解析「书名 + 作者」。支持：
 *   《书名》作者 / 书名 | 作者 / 书名｜作者 / 书名 / 作者
 *   自然语言：帮我解读《活着》，作者余华
 *   意图 + 空格：解读 平凡的世界 路遥 / 帮我拆解 活着 余华
 * @returns {{ title: string, author: string } | null}
 */
export function parseBookInput(raw) {
  let text = String(raw === null || raw === undefined ? '' : raw)
    .replace(/\r\n?/gu, '\n')
    .trim();
  if (text === '') return null;

  text = stripRequestMark(text);
  if (text === '') return null;

  text = text.replace(new RegExp(`^/${TOOL_NAME}\\b`, 'i'), '').trim();
  if (text === '') return null;

  const intentMatch = text.match(INTENT_PREFIX);
  const hadIntent = intentMatch !== null;
  if (hadIntent) {
    text = text.slice(intentMatch[0].length).trim();
    if (text === '') return null;
  }

  const angle = text.match(/《([^》\n]{1,200})》(.*)$/su);
  if (angle !== null) {
    const title = angle[1].trim();
    const author = cleanAuthorTail(angle[2]);
    if (title !== '' && author !== '') return { title, author };
  }

  const named = text.match(
    /[《「"']?([^》」"'\n|｜，,]{1,200}?)[》」"']?\s*[，,、]?\s*(?:作者(?:是)?|by)\s*[：:：]?\s*(.+)$/iu,
  );
  if (named !== null) {
    const title = cleanField(named[1], 200);
    const author = cleanAuthorTail(named[2]);
    if (title !== '' && author !== '') return { title, author };
  }

  const pipe = text
    .split(/[|｜]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (pipe.length >= 2) {
    const title = cleanField(pipe[0], 200);
    const author = cleanAuthorTail(pipe.slice(1).join(' '));
    if (title !== '' && author !== '') return { title, author };
  }

  const slash = text
    .split(/\s*\/\s*/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (slash.length >= 2) {
    const title = cleanField(slash[0], 200);
    const author = cleanAuthorTail(slash.slice(1).join(' '));
    if (title !== '' && author !== '') return { title, author };
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length >= 2) {
    const title = cleanField(lines[0], 200);
    const author = cleanAuthorTail(lines.slice(1).join(' '));
    if (title !== '' && author !== '') return { title, author };
  }

  // 仅在有解读意图时：末段当作者，前面当书名（避免误伤普通两词输入）
  if (hadIntent) {
    const parts = text
      .split(/\s+/u)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length >= 2) {
      const title = cleanField(parts.slice(0, -1).join(' '), 200);
      const author = cleanAuthorTail(parts[parts.length - 1]);
      if (title !== '' && author !== '') return { title, author };
    }
  }

  return null;
}

function newRequestId() {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/** 强制调工具；每次带唯一 requestId，避免同书重复请求被当成重复消息。 */
function buildToolSteerPrompt(parsed, raw, requestId) {
  const target =
    parsed !== null
      ? `解读《${parsed.title}》，作者${parsed.author}`
      : `处理：${raw}`;
  return (
    `${STEER_PREFIX}（${requestId}）${target}。` +
    '这是一次全新请求：即使用户重复同一本书，或本会话已解读过其他书，也必须再次调用工具；' +
    '禁止复用旧结果，禁止自己写短评代替。调用后把工具返回的全文原样展示给用户。'
  );
}

function messageText(message) {
  if (message === null || message === undefined || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n')
    .trim();
}

/**
 * 是否需要追加强制调工具提示。
 * 斜杠 followup 只投入「书名 | 作者」原文时，也要能识别并强制调工具。
 */
function shouldHandleFreeform(text) {
  if (text === '') return false;
  if (text.includes(STEER_PREFIX)) return false;

  const parsed = parseBookInput(text);
  if (parsed !== null) {
    if (hasBookIntent(text)) return true;
    // 斜杠命令 followup 的原文：平凡的世界 | 路遥 / 《书》作者
    if (/[|｜]/u.test(text) || /作者|by/iu.test(text) || /《.+》/u.test(text)) return true;
  }

  if (!hasBookIntent(text)) return false;
  return /作者|by|《.|》/u.test(text) || /[|｜]/u.test(text);
}

/** 不依赖 @deepseek-ai/dsh-llm（本地 file: 插件 realpath 解析不到宿主包）。 */
function makeUserMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'user' }),
  });
}

function makePluginMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({
      kind: `plugin:${TOOL_NAME}`,
      plugin: TOOL_NAME,
    }),
  });
}

function isPluginSource(source) {
  if (source !== null && source !== undefined) {
    const kind = source.kind;
    if (kind === 'plugin' || (typeof kind === 'string' && kind.startsWith('plugin:'))) return true;
  }
  return false;
}

function enqueueAgentMessage(agent, message) {
  if (agent !== null && agent !== undefined && typeof agent.followup === 'function') {
    agent.followup(message);
    return true;
  }
  if (agent !== null && agent !== undefined && typeof agent.steer === 'function') {
    agent.steer(message);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 提示词：只产出成品，不产出过程
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  '你是一位有洞察力的书籍解读者。只交付成品，不展示分析过程。',
  '',
  '输出有且仅有两部分：',
  '1. 书籍的故事情节：把整本书讲清楚（小说讲清人物与情节推进；非虚构讲清主线内容与关键论点）。不要一句话短评，也不要灌水啰嗦。',
  '2. 一段有深度的思考：全文最后只写一整段，不列条目、不加小标题。',
  '',
  '铁律：',
  '1. 只输出成品。不要写分析步骤、框架说明、知识边界、置信度、自我审校或元评论。',
  '2. 不编造。不确定的事实、引文、页码、奖项、时间线不要写。',
  '3. 你的推论须标明语气（如「由此可以推出」），勿冒充作者原话。',
  '4. 禁止鸡汤短评、书腰简介、朋友圈文案；也禁止为凑字数而重复、注水。',
  '5. 用中文 Markdown。若无法可靠解读该书，只写「我无法可靠地解读这本书」。',
].join('\n');

function buildAnalysisPrompt(title, author) {
  return `书名：《${title}》
作者：${author}

请直接输出成品，只写下面两部分，标题必须原样使用。不要写分析过程或元信息。

## 故事情节
把整本书讲清楚即可：
- 小说：主要人物、起因—发展—转折—结局，关键情节线；
- 非虚构：主线问题、各部分分别讲什么、关键论点/案例如何推进到结论。
要求：读完能掌握全书在讲什么；禁止一句话短评；禁止灌水、重复、百科词条或目录清单。篇幅以讲清为准，通常大约 800–1500 字，够用就停。

## 一段有深度的思考
紧接着写**一整段**（约 200–350 字，不要分条、不要小标题）：从全书提炼一个真正有深度的思考——它是什么、为何成立（扣住书中内容）、对读者意味着什么。除此之外不要再写别的部分。`;
}

// ---------------------------------------------------------------------------
// LLM 调用（工具路径使用；斜杠无 agent 时降级）
// ---------------------------------------------------------------------------

function resolveRoute(ctx, config) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model };
  }
  const defaultModel = ctx.get('agentDefaultModel');
  const selection =
    defaultModel !== undefined && typeof defaultModel.currentSelection === 'function'
      ? defaultModel.currentSelection()
      : undefined;
  if (selection !== undefined && selection.provider && selection.model) {
    return { provider: selection.provider, model: selection.model };
  }
  throw new Error('没有可用的模型：请在插件配置里设置 provider 和 model，或在设置里选择默认模型。');
}

async function generate(ctx, config, options) {
  const route = resolveRoute(ctx, config);
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: options.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: options.user }] }],
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    signal: options.signal,
  });

  let text = '';
  let sawDelta = false;
  const blockTexts = [];
  let finish;

  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      sawDelta = true;
      text += chunk.text;
    } else if (chunk.type === 'block-end') {
      if (chunk.block !== null && typeof chunk.block === 'object' && chunk.block.type === 'text') {
        blockTexts.push(chunk.block.text);
      }
    } else if (chunk.type === 'finish') {
      finish = chunk.reason;
    }
  }

  if (!sawDelta && blockTexts.length > 0) text = blockTexts.join('');

  if (finish !== undefined && finish.kind === 'error') {
    const message =
      finish.failure !== undefined && finish.failure !== null && finish.failure.message
        ? finish.failure.message
        : '未知错误';
    throw new Error('模型调用失败：' + message);
  }
  if (finish !== undefined && finish.kind === 'aborted') {
    throw new Error('模型调用被取消');
  }
  return { text: text.trim(), finish };
}

async function deconstruct(ctx, config, rawTitle, rawAuthor, options = {}) {
  const title = cleanField(rawTitle, 200);
  const author = cleanField(rawAuthor, 200);
  if (title === '') throw new Error('书名不能为空');
  if (author === '') throw new Error('作者不能为空');

  const result = await generate(ctx, config, {
    system: SYSTEM_PROMPT,
    user: buildAnalysisPrompt(title, author),
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    signal: options.signal,
  });
  if (result.text === '') throw new Error('模型没有返回内容，请稍后重试。');

  let output = result.text;
  if (result.finish !== undefined && result.finish.kind === 'max-tokens') {
    output += '\n\n> （输出达到长度上限，可能有截断）';
  }
  return output;
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const disposers = [];

  // 保留用户原话，只追加「必须调工具」提示；正文只由工具产出。
  disposers.push(
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next();
      if (decision.kind !== 'enter') return decision;

      let changed = false;
      const rewritten = [];
      for (const message of decision.messages) {
        if (isPluginSource(message.source)) {
          rewritten.push(message);
          continue;
        }
        const raw = messageText(message);
        if (!shouldHandleFreeform(raw)) {
          rewritten.push(message);
          continue;
        }

        changed = true;
        rewritten.push(message);
        rewritten.push(
          makePluginMessage(buildToolSteerPrompt(parseBookInput(raw), raw, newRequestId())),
        );
      }

      if (!changed) return decision;
      return { ...decision, messages: rewritten };
    }),
  );

  disposers.push(
    ctx.commands.register({
      name: TOOL_NAME,
      description: '书籍拆解：深度解读一本书。用法：/dsh-plugin-book-deconstruct 书名 | 作者',
      input: { hint: '书名 | 作者' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? '').trim();
        if (raw === '') return { kind: 'error', text: USAGE };

        const parsed = parseBookInput(raw);
        if (parsed === null) return { kind: 'error', text: USAGE };

        // 会话里只显示用户输入的书名/作者原文，不带 /命令 和请求号。
        // 强制调工具由 pre-step 追加（唯一 requestId 只在插件提示里）。
        const agent = invocation.agent;

        // 立刻回执，避免桌面端「点了发送没反应」。
        if (enqueueAgentMessage(agent, makeUserMessage(raw))) {
          return { kind: 'success', text: `已收到：${raw}` };
        }

        try {
          const text = await deconstruct(ctx, config, parsed.title, parsed.author, {
            signal: invocation.signal,
          });
          return { kind: 'success', text: `问题：${raw}\n\n${text}` };
        } catch (error) {
          const message = error !== null && error !== undefined && error.message ? error.message : String(error);
          return { kind: 'error', text: '解读失败：' + message };
        }
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        '深度解读一本书：先写「故事情节」（讲清整本书，勿一句话短评、勿灌水），再写「一段有深度的思考」。' +
        '用户要求解读/拆解某书时必须调用；即使用户重复同一本、或本会话已解读过其他书，也必须再次调用并重新生成；' +
        '禁止复用旧结果，禁止自己写短评代替。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '书名，例如《思考，快与慢》或“思考，快与慢”' },
          author: { type: 'string', description: '作者，例如“丹尼尔·卡尼曼”' },
        },
        required: ['title', 'author'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }];
        },
      },
      async execute(args, exec) {
        const payload = args !== null && typeof args === 'object' ? args : {};
        const title = cleanField(payload.title, 200);
        const author = cleanField(payload.author, 200);
        if (title === '' || author === '') throw new Error('title 和 author 必填');
        return deconstruct(ctx, config, title, author, { signal: exec.signal });
      },
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* ignore disposer errors */
      }
    }
  };
}
