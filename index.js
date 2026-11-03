/**
 * book-deconstruct — 输入书名 + 作者，直接输出成品级书籍解读。
 *
 * 输出只保留两部分：
 *   1. 这本书讲的是什么事（主体：详细讲清整本书的内容）
 *   2. 一段深度的思想（最后只写一段，不列条目）
 *
 * 两个入口共用同一套解读逻辑（工具 execute）：
 *   - `/book …` 斜杠命令：解析后 followup/steer 用户消息，让模型调用 book_deconstruct
 *   - `book_deconstruct` 工具（智能体在对话中调用）
 */

import { randomUUID } from 'node:crypto';

export const inject = ['llm', 'commands', 'tools'];

const DEFAULT_TEMPERATURE = 0.5;
const DEFAULT_MAX_TOKENS = 8000;

const USAGE = [
  '用法：/book 书名 | 作者',
  '示例：/book 思考，快与慢 | 丹尼尔·卡尼曼',
  '也支持：/book 《思考，快与慢》丹尼尔·卡尼曼',
  '或：/book 帮我解读《思考，快与慢》，作者丹尼尔·卡尼曼',
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

/**
 * 解析「书名 + 作者」。支持：
 *   《书名》作者 / 书名 | 作者 / 书名｜作者 / 书名 / 作者
 *   自然语言：帮我解读《活着》，作者余华
 * @returns {{ title: string, author: string } | null}
 */
export function parseBookInput(raw) {
  let text = String(raw === null || raw === undefined ? '' : raw)
    .replace(/\r\n?/gu, '\n')
    .trim();
  if (text === '') return null;

  text = text.replace(/^\/book\b/i, '').trim();
  if (text === '') return null;

  const angle = text.match(/《([^》\n]{1,200})》(.*)$/su);
  if (angle !== null) {
    const title = angle[1].trim();
    const author = cleanAuthorTail(angle[2]);
    if (title !== '' && author !== '') return { title, author };
  }

  const named = text.match(
    /(?:请?帮?我?)?(?:解读|拆解|总结|分析|讲讲|讲一下)?\s*[《「"']?([^》」"'\n|｜，,]{1,200}?)[》」"']?\s*[，,、]?\s*(?:作者(?:是)?|by)\s*[：:：]?\s*(.+)$/iu,
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

  return null;
}

function buildSteerPrompt(parsed, raw) {
  if (parsed !== null) {
    return (
      `必须调用 book_deconstruct 工具解读《${parsed.title}》，作者${parsed.author}。` +
      '不要自己直接写短评或一两句话概括；完整解读由该工具产出。'
    );
  }
  return (
    `必须调用 book_deconstruct 工具处理用户的书籍解读请求：${raw}。` +
    '不要自己直接写短评或一两句话概括；完整解读由该工具产出。'
  );
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

function enqueueUserTurn(agent, message) {
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
  '你是一位有洞察力的书籍解读者。你的任务不是展示分析过程，而是直接交付高质量的成品：把一本书讲透，并在最后给出一段有深度的思想。',
  '',
  '铁律：',
  '1. 只输出成品内容。不要写你的分析步骤、框架说明、知识边界声明、置信度清单、自我审校或任何元评论。',
  '2. 不编造。对不确定的事实、引文、页码、章节、销量、奖项、时间线，不要写；宁可少写，也不要虚构。',
  '3. 区分「书中明确观点」与「你的推论/评价」。属于你的推论时，用「由此可以推出」「这意味着」等措辞，不要冒充作者原话。',
  '4. 不写目录复述，不写百科词条。要写出这本书的骨架和真正的洞见。',
  '5. 用中文 Markdown，深度优先，语言干净利落，不堆砌空洞形容词。',
  '6. 如果对书名或作者没有可靠信息，直接说明「我无法可靠地解读这本书」，不要编造内容。',
  '7. 严禁一两句话交差。主体部分必须展开到约 1200–1800 字；最后的思想约 250–400 字。达不到这个厚度就继续写，不要提前收束。',
  '8. 不要写成鸡汤短评、书腰简介或朋友圈文案；要让没读过的人也能大致掌握全书内容。',
].join('\n');

function buildAnalysisPrompt(title, author) {
  return `书名：《${title}》
作者：${author}

请直接输出成品，只写下面两部分，不要写任何分析过程或元信息。

## 这本书讲的是什么事
用约 1200–1800 字把整本书的内容讲透（这是主体，严禁短评式一两段就结束）：
- 核心主题，以及它在回答什么问题；
- 结构与推进：大致分几部分/几条主线，各部分分别讲什么、如何推进；
- 关键人物或关键概念、核心论点、重要情节/方法/案例（用自己的话转述，不编造引文）；
- 作者的基本立场与最终落点。
写到让没读过的人读完也能掌握全书骨架；不要一句概括，不要目录清单，也不要灌水凑字。

## 一段深度的思想
用约 250–400 字写**一整段**（不要分条、不要小标题），提炼一个最深洞见：
- 它是什么；
- 为什么成立（扣住书中内容）；
- 对读者意味着什么。
只写这一段。

全文合计大约 1500–2200 字为宜：详细，但不写成论文或流水账。直接给结果，不要写分析过程或置信度。`;
}

// ---------------------------------------------------------------------------
// LLM 调用（仅工具路径使用；斜杠命令改走 agent 回合）
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

  disposers.push(
    ctx.commands.register({
      // 挂 input.hint：从 / 菜单选 book 时保留输入框，继续填「书名 | 作者」。
      // 也可整行输入 /book 书名 | 作者 后直接发送。
      name: 'book',
      description: '书籍拆解：深度解读一本书。用法：/book 书名 | 作者',
      input: { hint: '书名 | 作者' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? '').trim();
        if (raw === '') return { kind: 'error', text: USAGE };

        const parsed = parseBookInput(raw);
        if (parsed === null && !/作者|by|《.|》/u.test(raw) && !/[|｜]/u.test(raw)) {
          return { kind: 'error', text: USAGE };
        }

        // 桌面端：先 steer/followup 让会话调用工具（整行发送才有反应）。
        // 不要在 handler 里长时间 await 模型，否则输入框像「点了没反应」。
        const prompt = buildSteerPrompt(parsed, raw);
        const agent = invocation.agent;
        const ok = enqueueUserTurn(agent, makeUserMessage(prompt));
        if (ok) {
          if (parsed !== null) {
            return {
              kind: 'success',
              text: `已提交解读：《${parsed.title}》 / ${parsed.author}（请等待 book_deconstruct 产出完整解读，勿自行短评）`,
            };
          }
          return { kind: 'success', text: '已提交书籍解读请求（将调用 book_deconstruct）' };
        }

        if (parsed === null) {
          return { kind: 'error', text: USAGE };
        }
        try {
          const text = await deconstruct(ctx, config, parsed.title, parsed.author, {
            signal: invocation.signal,
          });
          return { kind: 'success', text };
        } catch (error) {
          const message = error !== null && error !== undefined && error.message ? error.message : String(error);
          return { kind: 'error', text: '解读失败：' + message };
        }
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'book_deconstruct',
      description:
        '深度解读一本书：输入书名与作者，产出约 1500–2200 字的成品（主体讲透全书约 1200–1800 字，最后一段思想约 250–400 字）。禁止一两句短评。当用户要求解读/总结/拆解某本书时必须调用本工具，不要自己直接写短文替代。',
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
