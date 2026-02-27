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
      expect(result).toContain('[m_1000000000000] 叫小王 [2026-02-20]');
      expect(result).not.toContain('## 偏好习惯');
      expect(result).toContain('## 近期动态');
      expect(result).toContain('[m_1000000000001] 在准备面试 [2026-02-23]');
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
    it('concatenates system and memory with separator and priority rules', async () => {
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

      const result = await prompts.buildSystemPrompt();

      expect(result).toContain('system');
      expect(result).toContain('# 关于用户的记忆');
      expect(result).toContain('memory item');
      expect(result).toContain('# 优先级规则');
    });

    it('returns only system when memory store is empty', async () => {
      readFileSpy.mockImplementation((filePath) => {
        if (filePath === prompts.SYSTEM_PATH) return Promise.resolve('system');
        if (filePath === prompts.MEMORY_JSON_PATH) {
          return Promise.resolve(JSON.stringify({ version: 1, identity: [], preferences: [], events: [] }));
        }
        if (filePath === prompts.MEMORY_PATH) return Promise.resolve('');
        return Promise.reject(new Error('unexpected path'));
      });

      const result = await prompts.buildSystemPrompt();
      expect(result).toContain('system');
      // 输出格式规则始终注入
      expect(result).toContain('输出格式规则');
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

      const result = await prompts.buildSystemPrompt({ ai_name: '小助', user_name: '鹿鹿' });
      expect(result).toContain('小助');
      expect(result).toContain('鹿鹿');
      expect(result).toContain('# 个性化设定');
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

  describe('selectMemoryForPrompt', () => {
    const mkItem = (id, text, date, source = 'ai_inferred') => ({ id, text, date, source });

    it('renders all categories when within budget', () => {
      const store = {
        version: 1,
        identity: [mkItem('m_1000000000000', '叫小王', '2026-02-20', 'user_stated')],
        preferences: [mkItem('m_1000000000001', '喜欢简洁风格', '2026-02-21')],
        events: [mkItem('m_1000000000002', '在准备面试', '2026-02-23')],
      };
      const result = prompts.selectMemoryForPrompt(store, 9999);
      expect(result).toContain('## 核心身份');
      expect(result).toContain('叫小王');
      expect(result).toContain('## 偏好习惯');
      expect(result).toContain('喜欢简洁风格');
      expect(result).toContain('## 近期动态');
      expect(result).toContain('在准备面试');
    });

    it('always includes identity even with extremely low budget', () => {
      const store = {
        version: 1,
        identity: [mkItem('m_1000000000000', '叫小王', '2026-02-20', 'user_stated')],
        preferences: [mkItem('m_1000000000001', '喜欢简洁', '2026-02-21')],
        events: [mkItem('m_1000000000002', '在面试', '2026-02-23')],
      };
      const result = prompts.selectMemoryForPrompt(store, 1);
      expect(result).toContain('叫小王');
      // preferences and events should be truncated
      expect(result).not.toContain('喜欢简洁');
      expect(result).not.toContain('在面试');
    });

    it('truncates events before preferences when over budget', () => {
      const store = {
        version: 1,
        identity: [],
        preferences: [mkItem('m_1000000000001', '偏好A', '2026-02-21')],
        events: [
          mkItem('m_1000000000002', '事件A较长文本用来占预算', '2026-02-23'),
          mkItem('m_1000000000003', '事件B较长文本用来占预算', '2026-02-22'),
        ],
      };
      // Now restrict budget: enough for preference + 1 event
      const headerCost = prompts.estimateTokens('## 偏好习惯\n') + prompts.estimateTokens('## 近期动态\n');
      const prefCost = prompts.estimateTokens('- 偏好A [2026-02-21]\n');
      const eventCost = prompts.estimateTokens('- 事件A较长文本用来占预算 [2026-02-23]\n');
      const tightBudget = headerCost + prefCost + eventCost + 1; // just enough for pref + 1 event
      const result = prompts.selectMemoryForPrompt(store, tightBudget);
      expect(result).toContain('偏好A');
      expect(result).toContain('事件A'); // newer event kept
      expect(result).not.toContain('事件B'); // older event truncated
    });

    it('sorts preferences and events by date descending (newer first)', () => {
      const store = {
        version: 1,
        identity: [],
        preferences: [],
        events: [
          mkItem('m_1000000000002', '旧事件', '2026-01-01'),
          mkItem('m_1000000000003', '新事件', '2026-02-23'),
        ],
      };
      const result = prompts.selectMemoryForPrompt(store, 9999);
      const newIdx = result.indexOf('新事件');
      const oldIdx = result.indexOf('旧事件');
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it('returns empty string for empty store', () => {
      const store = { version: 1, identity: [], preferences: [], events: [] };
      expect(prompts.selectMemoryForPrompt(store)).toBe('');
    });

    it('returns empty string for invalid store', () => {
      expect(prompts.selectMemoryForPrompt(null)).toBe('');
      expect(prompts.selectMemoryForPrompt('bad')).toBe('');
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
      const result = prompts.selectMemoryForPrompt(store);
      const lineCount = (result.match(/^- /gm) || []).length;
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
      // NaN and negative should not crash, should behave like default budget
      expect(prompts.selectMemoryForPrompt(store, NaN)).toContain('叫小王');
      expect(prompts.selectMemoryForPrompt(store, -1)).toContain('叫小王');
      expect(prompts.selectMemoryForPrompt(store, 'bad')).toContain('叫小王');
    });

    it('output format matches renderMemoryForPrompt when all items fit', () => {
      const store = {
        version: 1,
        identity: [mkItem('m_1000000000000', '叫小王', '2026-02-20', 'user_stated')],
        preferences: [mkItem('m_1000000000001', '喜欢简洁风格', '2026-02-21')],
        events: [mkItem('m_1000000000002', '在准备面试', '2026-02-23')],
      };
      // When everything fits, format should be identical to renderMemoryForPrompt
      const selected = prompts.selectMemoryForPrompt(store, 9999);
      const rendered = prompts.renderMemoryForPrompt(store);
      expect(selected).toBe(rendered);
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
