const fs = require('fs');
const prompts = require('../lib/prompts');

vi.mock('../lib/config', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    atomicWrite: vi.fn().mockResolvedValue(),
  };
});

describe('lib/prompts', () => {
  let readFileSpy;

  beforeEach(() => {
    readFileSpy = vi.spyOn(fs.promises, 'readFile');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readPromptFile', () => {
    it('returns file content when file exists', async () => {
      readFileSpy.mockResolvedValue('hello prompt');
      const result = await prompts.readPromptFile('some/path.md');
      expect(result).toBe('hello prompt');
      expect(readFileSpy).toHaveBeenCalledWith('some/path.md', 'utf-8');
    });

    it('returns empty string when file does not exist', async () => {
      readFileSpy.mockRejectedValue(new Error('ENOENT'));
      const result = await prompts.readPromptFile('missing.md');
      expect(result).toBe('');
    });
  });

  describe('renderMemoryForPrompt', () => {
    it('renders all three categories', () => {
      const store = {
        version: 1,
        identity: [{ id: 'm_1000000000000', text: '叫小王', date: '2026-02-20', source: 'user_stated' }],
        preferences: [{ id: 'm_1000000000001', text: '喜欢简洁风格', date: '2026-02-21', source: 'ai_inferred' }],
        events: [{ id: 'm_1000000000002', text: '在准备面试', date: '2026-02-23', source: 'ai_inferred' }],
      };

      const result = prompts.renderMemoryForPrompt(store);
      expect(result).toContain('## 核心身份');
      expect(result).toContain('- 叫小王 [2026-02-20]');
      expect(result).toContain('## 偏好习惯');
      expect(result).toContain('- 喜欢简洁风格 [2026-02-21]');
      expect(result).toContain('## 近期动态');
      expect(result).toContain('- 在准备面试 [2026-02-23]');
    });

    it('omits empty categories', () => {
      const store = {
        version: 1,
        identity: [{ id: 'm_1000000000000', text: '叫小王', date: '2026-02-20', source: 'user_stated' }],
        preferences: [],
        events: [],
      };

      const result = prompts.renderMemoryForPrompt(store);
      expect(result).toContain('## 核心身份');
      expect(result).not.toContain('## 偏好习惯');
      expect(result).not.toContain('## 近期动态');
    });

    it('returns empty string for all-empty store', () => {
      const store = { version: 1, identity: [], preferences: [], events: [] };
      expect(prompts.renderMemoryForPrompt(store)).toBe('');
    });

    it('returns empty string for invalid store', () => {
      expect(prompts.renderMemoryForPrompt(null)).toBe('');
      expect(prompts.renderMemoryForPrompt('bad')).toBe('');
    });
  });

  describe('renderMemoryWithIds', () => {
    it('renders memory items with their IDs', () => {
      const store = {
        version: 1,
        identity: [{ id: 'm_1000000000000', text: '叫小王', date: '2026-02-20', source: 'user_stated' }],
        preferences: [],
        events: [{ id: 'm_1000000000001', text: '在准备面试', date: '2026-02-23', source: 'ai_inferred' }],
      };
      const result = prompts.renderMemoryWithIds(store);
      expect(result).toContain('## 核心身份');
      expect(result).toContain('[m_1000000000000] ★★ 叫小王 [2026-02-20]');
      expect(result).not.toContain('## 偏好习惯');
      expect(result).toContain('## 近期动态');
      expect(result).toContain('[m_1000000000001] ★★ 在准备面试 [2026-02-23]');
    });

    it('renders ★★★ for importance 3, ★ for importance 1', () => {
      const store = {
        version: 1,
        identity: [{ id: 'm_1000000000000', text: '核心信息', date: '2026-02-20', source: 'user_stated', importance: 3 }],
        preferences: [{ id: 'm_1000000000001', text: '临时偏好', date: '2026-02-21', source: 'ai_inferred', importance: 1 }],
        events: [],
      };
      const result = prompts.renderMemoryWithIds(store);
      expect(result).toContain('[m_1000000000000] ★★★ 核心信息 [2026-02-20]');
      expect(result).toContain('[m_1000000000001] ★ 临时偏好 [2026-02-21]');
    });

    it('defaults to ★★ when importance is missing', () => {
      const store = {
        version: 1,
        identity: [{ id: 'm_1000000000000', text: '无importance', date: '2026-02-20', source: 'user_stated' }],
        preferences: [],
        events: [],
      };
      const result = prompts.renderMemoryWithIds(store);
      expect(result).toContain('[m_1000000000000] ★★ 无importance [2026-02-20]');
    });

    it('returns empty string for empty store', () => {
      const store = { version: 1, identity: [], preferences: [], events: [] };
      expect(prompts.renderMemoryWithIds(store)).toBe('');
    });

    it('returns empty string for invalid store', () => {
      expect(prompts.renderMemoryWithIds(null)).toBe('');
      expect(prompts.renderMemoryWithIds('bad')).toBe('');
    });
  });

  describe('migrateMemoryMd', () => {
    it('parses 用户画像 section into identity', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.MEMORY_PATH) {
          return Promise.resolve('## 用户画像\n\n- 叫小王，95后\n- 在北京');
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const store = await prompts.migrateMemoryMd();
      expect(store.identity).toHaveLength(2);
      expect(store.identity[0].text).toBe('叫小王，95后');
      expect(store.identity[0].source).toBe('user_stated');
      expect(store.identity[1].text).toBe('在北京');
    });

    it('parses 长期记忆 section with dates into preferences', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.MEMORY_PATH) {
          return Promise.resolve('## 长期记忆\n\n- [2026-02-20] 喜欢简洁风格\n- [2026-02-21] 在学 Python');
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const store = await prompts.migrateMemoryMd();
      expect(store.preferences).toHaveLength(2);
      expect(store.preferences[0].text).toBe('喜欢简洁风格');
      expect(store.preferences[0].date).toBe('2026-02-20');
      expect(store.preferences[0].source).toBe('ai_inferred');
    });

    it('parses new format headers (核心身份/偏好习惯/近期动态)', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.MEMORY_PATH) {
          return Promise.resolve(
            '## 核心身份\n- 程序员 [2026-02-25]\n\n## 偏好习惯\n- 喜欢TypeScript [2026-02-26]\n\n## 近期动态\n- 在学Rust [2026-02-27]'
          );
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const store = await prompts.migrateMemoryMd();
      expect(store.identity).toHaveLength(1);
      expect(store.identity[0].text).toBe('程序员');
      expect(store.identity[0].date).toBe('2026-02-25');
      expect(store.preferences).toHaveLength(1);
      expect(store.preferences[0].text).toBe('喜欢TypeScript');
      expect(store.preferences[0].date).toBe('2026-02-26');
      expect(store.events).toHaveLength(1);
      expect(store.events[0].text).toBe('在学Rust');
      expect(store.events[0].date).toBe('2026-02-27');
    });

    it('parses date suffix format (text [YYYY-MM-DD])', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.MEMORY_PATH) {
          return Promise.resolve('## 用户画像\n\n- 叫小王 [2026-01-15]');
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const store = await prompts.migrateMemoryMd();
      expect(store.identity).toHaveLength(1);
      expect(store.identity[0].text).toBe('叫小王');
      expect(store.identity[0].date).toBe('2026-01-15');
      expect(store.identity[0].source).toBe('ai_inferred');
    });

    it('puts headerless bullets into events by default', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.MEMORY_PATH) {
          return Promise.resolve('- 无标题的记忆条目\n- 另一条');
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const store = await prompts.migrateMemoryMd();
      expect(store.events).toHaveLength(2);
      expect(store.events[0].text).toBe('无标题的记忆条目');
      expect(store.identity).toHaveLength(0);
      expect(store.preferences).toHaveLength(0);
    });

    it('skips template placeholder lines', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.MEMORY_PATH) {
          return Promise.resolve('## 用户画像\n\n- （在这里写下你的基本信息、性格特点、偏好等）');
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const store = await prompts.migrateMemoryMd();
      expect(store.identity).toHaveLength(0);
    });

    it('returns empty store when memory.md is empty', async () => {
      readFileSpy.mockResolvedValue('');
      const store = await prompts.migrateMemoryMd();
      expect(store.identity).toEqual([]);
      expect(store.preferences).toEqual([]);
      expect(store.events).toEqual([]);
    });

    it('generates unique IDs for each entry', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.MEMORY_PATH) {
          return Promise.resolve('## 用户画像\n\n- a\n- b\n- c');
        }
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });

      const store = await prompts.migrateMemoryMd();
      const ids = store.identity.map((item) => item.id);
      expect(new Set(ids).size).toBe(3);
      ids.forEach((id) => expect(id).toMatch(/^m_\d+/));
    });
  });

  describe('buildSystemPrompt', () => {
    it('returns { prompt, selectedIds } with memory and priority rules', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.SYSTEM_PATH) return Promise.resolve('system');
        if (filePath === prompts.MEMORY_JSON_PATH) {
          return Promise.resolve(JSON.stringify({
            version: 1,
            identity: [{ id: 'm_1000000000000', text: 'memory item', date: '2026-01-01', source: 'user_stated' }],
            preferences: [],
            events: [],
          }));
        }
        if (filePath === prompts.MEMORY_PATH) return Promise.resolve('');
        return Promise.reject(new Error('unexpected path'));
      });

      const { prompt, selectedIds } = await prompts.buildSystemPrompt();

      expect(prompt).toContain('system');
      expect(prompt).toContain('# 关于用户的记忆');
      expect(prompt).toContain('memory item');
      expect(prompt).toContain('# 优先级规则');
      expect(selectedIds).toContain('m_1000000000000');
    });

    it('returns empty selectedIds when memory store is empty', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.SYSTEM_PATH) return Promise.resolve('system');
        if (filePath === prompts.MEMORY_JSON_PATH) {
          return Promise.resolve(JSON.stringify({ version: 1, identity: [], preferences: [], events: [] }));
        }
        if (filePath === prompts.MEMORY_PATH) return Promise.resolve('');
        return Promise.reject(new Error('unexpected path'));
      });

      const { prompt, selectedIds } = await prompts.buildSystemPrompt();
      expect(prompt).toContain('system');
      expect(prompt).toContain('输出格式规则');
      expect(selectedIds).toEqual([]);
    });

    it('adds personalization when config has ai_name and user_name', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.SYSTEM_PATH) return Promise.resolve('system');
        if (filePath === prompts.MEMORY_JSON_PATH) {
          return Promise.resolve(JSON.stringify({ version: 1, identity: [], preferences: [], events: [] }));
        }
        if (filePath === prompts.MEMORY_PATH) return Promise.resolve('');
        return Promise.reject(new Error('unexpected path'));
      });

      const { prompt } = await prompts.buildSystemPrompt({ ai_name: '小助', user_name: '鹿鹿' });
      expect(prompt).toContain('小助');
      expect(prompt).toContain('鹿鹿');
      expect(prompt).toContain('# 个性化设定');
    });
  });

  describe('estimateTokens', () => {
    it('returns 0 for empty/null/undefined input', () => {
      expect(prompts.estimateTokens('')).toBe(0);
      expect(prompts.estimateTokens(null)).toBe(0);
      expect(prompts.estimateTokens(undefined)).toBe(0);
    });

    it('estimates CJK text higher than same-length ASCII text', () => {
      const cjk = prompts.estimateTokens('你好世界');       // 4 CJK → ~8
      const ascii = prompts.estimateTokens('abcd');          // 4 ASCII → ~1.2
      expect(cjk).toBeGreaterThan(ascii);
    });

    it('returns a positive integer for non-empty text', () => {
      expect(prompts.estimateTokens('test')).toBeGreaterThan(0);
      expect(prompts.estimateTokens('测试')).toBeGreaterThan(0);
      expect(Number.isInteger(prompts.estimateTokens('hello 世界'))).toBe(true);
    });

    it('handles mixed CJK and ASCII', () => {
      const mixed = prompts.estimateTokens('hello 你好');
      const pureCjk = prompts.estimateTokens('你好');
      const pureAscii = prompts.estimateTokens('hello ');
      expect(mixed).toBe(pureCjk + pureAscii);
    });
  });

  describe('computeMemoryScore', () => {
    it('returns higher score for higher importance at same date', () => {
      const today = new Date().toISOString().slice(0, 10);
      const high = prompts.computeMemoryScore({ importance: 3, date: today });
      const mid = prompts.computeMemoryScore({ importance: 2, date: today });
      const low = prompts.computeMemoryScore({ importance: 1, date: today });
      expect(high).toBeGreaterThan(mid);
      expect(mid).toBeGreaterThan(low);
    });

    it('returns higher score for newer date at same importance', () => {
      const recentDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);  // 3 days ago
      const oldDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);    // 60 days ago
      const recent = prompts.computeMemoryScore({ importance: 2, date: recentDate });
      const old = prompts.computeMemoryScore({ importance: 2, date: oldDate });
      expect(recent).toBeGreaterThan(old);
    });

    it('recencyWeight floors at 0.1 for very old items', () => {
      const score = prompts.computeMemoryScore({ importance: 2, date: '2020-01-01' });
      // recencyWeight = max(0.1, ...) → importance(2) × 0.1 = 0.2
      expect(score).toBeCloseTo(0.2, 1);
    });

    it('defaults importance to 2 when missing', () => {
      const today = new Date().toISOString().slice(0, 10);
      const withDefault = prompts.computeMemoryScore({ date: today });
      const explicit = prompts.computeMemoryScore({ importance: 2, date: today });
      expect(withDefault).toBeCloseTo(explicit, 5);
    });
  });

  describe('selectMemoryForPrompt', () => {
    const mkItem = (id, text, date, source = 'ai_inferred', extra = {}) => ({ id, text, date, source, ...extra });

    it('renders all categories when within budget', () => {
      const store = {
        version: 1,
        identity: [mkItem('m_1000000000000', '叫小王', '2026-02-20', 'user_stated')],
        preferences: [mkItem('m_1000000000001', '喜欢简洁风格', '2026-02-21')],
        events: [mkItem('m_1000000000002', '在准备面试', '2026-02-23')],
      };
      const { text, selectedIds } = prompts.selectMemoryForPrompt(store, 9999);
      expect(text).toContain('## 核心身份');
      expect(text).toContain('叫小王');
      expect(text).toContain('## 偏好习惯');
      expect(text).toContain('喜欢简洁风格');
      expect(text).toContain('## 近期动态');
      expect(text).toContain('在准备面试');
      expect(selectedIds).toEqual(['m_1000000000000', 'm_1000000000001', 'm_1000000000002']);
    });

    it('always includes identity even with extremely low budget', () => {
      const store = {
        version: 1,
        identity: [mkItem('m_1000000000000', '叫小王', '2026-02-20', 'user_stated')],
        preferences: [mkItem('m_1000000000001', '喜欢简洁', '2026-02-21')],
        events: [mkItem('m_1000000000002', '在面试', '2026-02-23')],
      };
      const { text } = prompts.selectMemoryForPrompt(store, 1);
      expect(text).toContain('叫小王');
      expect(text).not.toContain('喜欢简洁');
      expect(text).not.toContain('在面试');
    });

    it('truncates lower-score events before preferences when over budget', () => {
      const store = {
        version: 1,
        identity: [],
        preferences: [mkItem('m_1000000000001', '偏好A', '2026-02-21')],
        events: [
          mkItem('m_1000000000002', '事件A较长文本用来占预算', '2026-02-23'),
          mkItem('m_1000000000003', '事件B较长文本用来占预算', '2026-02-22'),
        ],
      };
      const headerCost = prompts.estimateTokens('## 偏好习惯\n') + prompts.estimateTokens('## 近期动态\n');
      const prefCost = prompts.estimateTokens('- 偏好A [2026-02-21]\n');
      const eventCost = prompts.estimateTokens('- 事件A较长文本用来占预算 [2026-02-23]\n');
      const tightBudget = headerCost + prefCost + eventCost + 1;
      const { text } = prompts.selectMemoryForPrompt(store, tightBudget);
      expect(text).toContain('偏好A');
      expect(text).toContain('事件A'); // higher score event kept
      expect(text).not.toContain('事件B'); // lower score event truncated
    });

    it('sorts by composite score (newer same-importance items first)', () => {
      const store = {
        version: 1,
        identity: [],
        preferences: [],
        events: [
          mkItem('m_1000000000002', '旧事件', '2026-01-01'),
          mkItem('m_1000000000003', '新事件', '2026-02-23'),
        ],
      };
      const { text } = prompts.selectMemoryForPrompt(store, 9999);
      const newIdx = text.indexOf('新事件');
      const oldIdx = text.indexOf('旧事件');
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it('high importance old item ranks above low importance new item', () => {
      const today = new Date().toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const store = {
        version: 1,
        identity: [],
        preferences: [
          mkItem('m_2000000000001', '核心偏好', thirtyDaysAgo, 'user_stated', { importance: 3 }),
          mkItem('m_2000000000002', '临时偏好', today, 'ai_inferred', { importance: 1 }),
        ],
        events: [],
      };
      // importance=3 × recencyWeight(~0.7) = 2.1 > importance=1 × 1.0 = 1.0
      const { text } = prompts.selectMemoryForPrompt(store, 9999);
      expect(text.indexOf('核心偏好')).toBeLessThan(text.indexOf('临时偏好'));
    });

    it('returns empty text and no ids for empty store', () => {
      const store = { version: 1, identity: [], preferences: [], events: [] };
      const { text, selectedIds } = prompts.selectMemoryForPrompt(store);
      expect(text).toBe('');
      expect(selectedIds).toEqual([]);
    });

    it('returns empty text and no ids for invalid store', () => {
      expect(prompts.selectMemoryForPrompt(null)).toEqual({ text: '', selectedIds: [] });
      expect(prompts.selectMemoryForPrompt('bad')).toEqual({ text: '', selectedIds: [] });
    });

    it('uses default budget of 1500 and truncates large stores', () => {
      const store = {
        version: 1,
        identity: [],
        preferences: [],
        events: Array.from({ length: 200 }, (_, i) => mkItem(
          `m_${1000000000000 + i}`,
          `这是第${i}条事件记录内容比较长来消耗预算`,
          '2026-02-20',
        )),
      };
      const { text } = prompts.selectMemoryForPrompt(store);
      const lineCount = (text.match(/^- /gm) || []).length;
      expect(lineCount).toBeLessThan(200);
      expect(lineCount).toBeGreaterThan(0);
    });

    it('falls back to default budget when budget is NaN or negative', () => {
      const store = {
        version: 1,
        identity: [mkItem('m_1000000000000', '叫小王', '2026-02-20', 'user_stated')],
        preferences: [],
        events: [],
      };
      expect(prompts.selectMemoryForPrompt(store, NaN).text).toContain('叫小王');
      expect(prompts.selectMemoryForPrompt(store, -1).text).toContain('叫小王');
      expect(prompts.selectMemoryForPrompt(store, 'bad').text).toContain('叫小王');
    });

    it('includes same items as renderMemoryForPrompt when all items fit', () => {
      const store = {
        version: 1,
        identity: [mkItem('m_1000000000000', '叫小王', '2026-02-20', 'user_stated')],
        preferences: [mkItem('m_1000000000001', '喜欢简洁风格', '2026-02-21')],
        events: [mkItem('m_1000000000002', '在准备面试', '2026-02-23')],
      };
      const { text } = prompts.selectMemoryForPrompt(store, 9999);
      const rendered = prompts.renderMemoryForPrompt(store);
      // 排序可能不同（selectMemoryForPrompt 按综合分排序），但内容应一致
      expect(text).toContain('叫小王');
      expect(text).toContain('喜欢简洁风格');
      expect(text).toContain('在准备面试');
      expect(text).toContain('## 核心身份');
      expect(text).toContain('## 偏好习惯');
      expect(text).toContain('## 近期动态');
    });
  });

  describe('parseMemoryText', () => {
    it('parses standard format headers (核心身份/偏好习惯/近期动态)', () => {
      const text = '## 核心身份\n- 程序员 [2026-02-25]\n\n## 偏好习惯\n- 喜欢TypeScript [2026-02-26]\n\n## 近期动态\n- 在学Rust [2026-02-27]';
      const result = prompts.parseMemoryText(text);
      expect(result.identity).toHaveLength(1);
      expect(result.identity[0]).toEqual({ text: '程序员', date: '2026-02-25', source: 'ai_inferred' });
      expect(result.preferences).toHaveLength(1);
      expect(result.preferences[0]).toEqual({ text: '喜欢TypeScript', date: '2026-02-26', source: 'ai_inferred' });
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({ text: '在学Rust', date: '2026-02-27', source: 'ai_inferred' });
    });

    it('parses old format headers (用户画像/长期记忆)', () => {
      const text = '## 用户画像\n- 叫小王\n\n## 长期记忆\n- [2026-02-20] 喜欢简洁风格';
      const result = prompts.parseMemoryText(text);
      expect(result.identity).toHaveLength(1);
      expect(result.identity[0].text).toBe('叫小王');
      expect(result.identity[0].source).toBe('user_stated');
      expect(result.preferences).toHaveLength(1);
      expect(result.preferences[0].text).toBe('喜欢简洁风格');
      expect(result.preferences[0].date).toBe('2026-02-20');
      expect(result.preferences[0].source).toBe('ai_inferred');
    });

    it('puts headerless bullets into events by default', () => {
      const text = '- 无标题的记忆\n- 另一条';
      const result = prompts.parseMemoryText(text);
      expect(result.events).toHaveLength(2);
      expect(result.identity).toHaveLength(0);
      expect(result.preferences).toHaveLength(0);
    });

    it('skips template placeholder lines', () => {
      const text = '## 用户画像\n- （在这里写下你的基本信息）\n- (placeholder)';
      const result = prompts.parseMemoryText(text);
      expect(result.identity).toHaveLength(0);
    });

    it('returns empty result for empty/null input', () => {
      expect(prompts.parseMemoryText('')).toEqual({ identity: [], preferences: [], events: [] });
      expect(prompts.parseMemoryText(null)).toEqual({ identity: [], preferences: [], events: [] });
    });

    it('does not include id or metadata fields', () => {
      const text = '## 核心身份\n- 测试 [2026-01-01]';
      const result = prompts.parseMemoryText(text);
      expect(result.identity[0]).not.toHaveProperty('id');
      expect(result.identity[0]).not.toHaveProperty('importance');
      expect(result.identity[0]).not.toHaveProperty('useCount');
      expect(result.identity[0]).not.toHaveProperty('lastReferencedAt');
    });
  });

  describe('bigramOverlap', () => {
    it('returns 1 for identical strings', () => {
      expect(prompts.bigramOverlap('喜欢吃辣', '喜欢吃辣')).toBe(1);
    });

    it('returns 0 for completely different strings', () => {
      expect(prompts.bigramOverlap('你好世界', 'abcdef')).toBe(0);
    });

    it('returns 0 for empty strings', () => {
      expect(prompts.bigramOverlap('', '你好')).toBe(0);
      expect(prompts.bigramOverlap('你好', '')).toBe(0);
    });

    it('returns partial overlap for similar strings', () => {
      const score = prompts.bigramOverlap('喜欢吃辣', '很喜欢吃辣的食物');
      expect(score).toBeGreaterThan(0.3);
      expect(score).toBeLessThan(1);
    });

    it('single char strings return 0 (no bigrams)', () => {
      expect(prompts.bigramOverlap('a', 'a')).toBe(0);
    });
  });

  describe('mergeTextIntoMemoryStore', () => {
    const existingStore = {
      version: 1,
      identity: [
        { id: 'm_1000000000000', text: '叫小王', date: '2026-02-20', source: 'user_stated', importance: 3, useCount: 10, lastReferencedAt: '2026-02-25T00:00:00.000Z' },
      ],
      preferences: [
        { id: 'm_1000000000001', text: '喜欢简洁风格', date: '2026-02-21', source: 'ai_inferred', importance: 2, useCount: 5, lastReferencedAt: '2026-02-24T00:00:00.000Z' },
      ],
      events: [
        { id: 'm_1000000000002', text: '在准备面试', date: '2026-02-23', source: 'ai_inferred', importance: 1, useCount: 2, lastReferencedAt: '2026-02-23T00:00:00.000Z' },
      ],
    };

    it('inherits metadata for exact match entries', () => {
      const text = '## 核心身份\n- 叫小王 [2026-02-20]\n\n## 偏好习惯\n- 喜欢简洁风格 [2026-02-21]\n\n## 近期动态\n- 在准备面试 [2026-02-23]';
      const result = prompts.mergeTextIntoMemoryStore(text, existingStore);

      expect(result.identity[0].id).toBe('m_1000000000000');
      expect(result.identity[0].importance).toBe(3);
      expect(result.identity[0].useCount).toBe(10);
      expect(result.identity[0].lastReferencedAt).toBe('2026-02-25T00:00:00.000Z');

      expect(result.preferences[0].id).toBe('m_1000000000001');
      expect(result.preferences[0].importance).toBe(2);
      expect(result.preferences[0].useCount).toBe(5);

      expect(result.events[0].id).toBe('m_1000000000002');
      expect(result.events[0].importance).toBe(1);
      expect(result.events[0].useCount).toBe(2);
    });

    it('assigns defaults for completely new entries', () => {
      const text = '## 核心身份\n- 全新的身份信息 [2026-02-28]';
      const result = prompts.mergeTextIntoMemoryStore(text, existingStore);

      expect(result.identity[0].id).toMatch(/^m_\d+/);
      expect(result.identity[0].id).not.toBe('m_1000000000000');
      expect(result.identity[0].importance).toBe(2);
      expect(result.identity[0].useCount).toBe(0);
      expect(result.identity[0].lastReferencedAt).toBeNull();
    });

    it('handles mixed: some matched, some new', () => {
      const text = '## 核心身份\n- 叫小王 [2026-02-20]\n\n## 偏好习惯\n- 喜欢简洁风格 [2026-02-21]\n- 新的偏好 [2026-02-28]';
      const result = prompts.mergeTextIntoMemoryStore(text, existingStore);

      // 已有条目继承
      expect(result.identity[0].id).toBe('m_1000000000000');
      expect(result.identity[0].importance).toBe(3);
      expect(result.preferences[0].id).toBe('m_1000000000001');
      expect(result.preferences[0].useCount).toBe(5);

      // 新条目默认值
      expect(result.preferences[1].importance).toBe(2);
      expect(result.preferences[1].useCount).toBe(0);
    });

    it('matches across categories (LLM moves event to preferences)', () => {
      const text = '## 偏好习惯\n- 在准备面试 [2026-02-23]';
      const result = prompts.mergeTextIntoMemoryStore(text, existingStore);

      // 原本在 events，现在在 preferences，但元数据应继承
      expect(result.preferences[0].id).toBe('m_1000000000002');
      expect(result.preferences[0].importance).toBe(1);
      expect(result.preferences[0].useCount).toBe(2);
      expect(result.events).toHaveLength(0);
    });

    it('handles empty existingStore (all entries get defaults)', () => {
      const emptyStore = { version: 1, identity: [], preferences: [], events: [] };
      const text = '## 核心身份\n- 测试条目 [2026-02-28]';
      const result = prompts.mergeTextIntoMemoryStore(text, emptyStore);

      expect(result.identity).toHaveLength(1);
      expect(result.identity[0].importance).toBe(2);
      expect(result.identity[0].useCount).toBe(0);
    });

    it('prevents one-to-many matching (same old entry matched only once)', () => {
      const text = '## 核心身份\n- 叫小王 [2026-02-20]\n- 叫小王 [2026-02-28]';
      const result = prompts.mergeTextIntoMemoryStore(text, existingStore);

      // First match inherits, second gets new ID
      expect(result.identity[0].id).toBe('m_1000000000000');
      expect(result.identity[1].id).not.toBe('m_1000000000000');
      expect(result.identity[1].id).toMatch(/^m_\d+/);
    });

    it('inherits metadata for slightly reworded entries', () => {
      // "喜欢简洁风格" → "喜欢简洁的风格" should still match (>0.5 overlap)
      const text = '## 偏好习惯\n- 喜欢简洁的风格 [2026-02-21]';
      const result = prompts.mergeTextIntoMemoryStore(text, existingStore);

      expect(result.preferences[0].id).toBe('m_1000000000001');
      expect(result.preferences[0].text).toBe('喜欢简洁的风格');
      expect(result.preferences[0].useCount).toBe(5);
    });

    it('does not match when bigram overlap is exactly 0.5 (prevents false positives)', () => {
      const store = {
        version: 1,
        identity: [
          { id: 'm_1000000000000', text: '叫小王', date: '2026-02-20', source: 'user_stated', importance: 3, useCount: 10, lastReferencedAt: null },
        ],
        preferences: [], events: [],
      };
      // "叫小王" vs "叫小李": bigrams {叫小,小王} vs {叫小,小李} → overlap = 1/2 = 0.5 (exactly)
      // Strict > 0.5 means no match — correct, these are different people
      const text = '## 核心身份\n- 叫小李 [2026-02-20]';
      const result = prompts.mergeTextIntoMemoryStore(text, store);
      expect(result.identity[0].id).not.toBe('m_1000000000000');
      expect(result.identity[0].importance).toBe(2); // defaults, not inherited
    });

    it('returns empty store when merging empty text', () => {
      const result = prompts.mergeTextIntoMemoryStore('', existingStore);
      expect(result.identity).toHaveLength(0);
      expect(result.preferences).toHaveLength(0);
      expect(result.events).toHaveLength(0);
      expect(result).toHaveProperty('updatedAt');
    });

    it('returns valid store structure with updatedAt', () => {
      const text = '## 核心身份\n- 测试 [2026-02-28]';
      const result = prompts.mergeTextIntoMemoryStore(text, existingStore);

      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('updatedAt');
      expect(result).toHaveProperty('identity');
      expect(result).toHaveProperty('preferences');
      expect(result).toHaveProperty('events');
    });
  });

  describe('constants', () => {
    it('DEFAULT_SYSTEM is a string (blank for new users)', () => {
      expect(typeof prompts.DEFAULT_SYSTEM).toBe('string');
    });

    it('DEFAULT_MEMORY is a non-empty string', () => {
      expect(typeof prompts.DEFAULT_MEMORY).toBe('string');
      expect(prompts.DEFAULT_MEMORY.trim().length).toBeGreaterThan(0);
    });

    it('DEFAULT_MEMORY_STORE has correct structure', () => {
      expect(prompts.DEFAULT_MEMORY_STORE).toEqual({
        version: 1,
        identity: [],
        preferences: [],
        events: [],
      });
    });

    it('SYSTEM_PATH contains system.md', () => {
      expect(prompts.SYSTEM_PATH).toContain('system.md');
    });

    it('MEMORY_PATH contains memory.md', () => {
      expect(prompts.MEMORY_PATH).toContain('memory.md');
    });

    it('MEMORY_JSON_PATH contains memory.json', () => {
      expect(prompts.MEMORY_JSON_PATH).toContain('memory.json');
    });
  });
});
