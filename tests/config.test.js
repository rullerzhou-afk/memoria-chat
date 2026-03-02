vi.mock('../lib/clients', () => ({
  openaiClient: null,
  arkClient: null,
  openrouterClient: null,
  getClientForModel: vi.fn(),
  resolveDefaultModel: vi.fn(() => 'gpt-4o'),
  formatProviderError: vi.fn(),
  DEFAULT_CONFIG: { model: 'gpt-4o', temperature: 1, presence_penalty: 0, frequency_penalty: 0 },
}));

const { isPlainObject, clampNumber, normalizeConfig, getConversationPath, atomicWrite, createMutex } = require('../lib/config');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const DEFAULT_CONFIG = {
  model: 'gpt-4o',
  temperature: 1,
  presence_penalty: 0,
  frequency_penalty: 0,
};

describe('isPlainObject', () => {
  it('{} -> true', () => {
    expect(isPlainObject({})).toBe(true);
  });

  it('[] -> false', () => {
    expect(isPlainObject([])).toBe(false);
  });

  it('null -> false', () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it('undefined -> false', () => {
    expect(isPlainObject(undefined)).toBe(false);
  });

  it('"string" -> false', () => {
    expect(isPlainObject('string')).toBe(false);
  });

  it('123 -> false', () => {
    expect(isPlainObject(123)).toBe(false);
  });

  it('new Date() -> false', () => {
    expect(isPlainObject(new Date())).toBe(false);
  });
});

describe('clampNumber', () => {
  it('returns value when in range', () => {
    expect(clampNumber(5, 0, 10, 0)).toBe(5);
  });

  it('returns max when exceeds upper bound', () => {
    expect(clampNumber(11, 0, 10, 0)).toBe(10);
  });

  it('returns min when below lower bound', () => {
    expect(clampNumber(-1, 0, 10, 0)).toBe(0);
  });

  it('returns fallback for undefined', () => {
    expect(clampNumber(undefined, 0, 10, 7)).toBe(7);
  });

  it('returns fallback for NaN', () => {
    expect(clampNumber(NaN, 0, 10, 7)).toBe(7);
  });

  it('returns fallback for non-number', () => {
    expect(clampNumber('5', 0, 10, 7)).toBe(7);
  });

  it('returns value at boundary (min and max)', () => {
    expect(clampNumber(0, 0, 10, 7)).toBe(0);
    expect(clampNumber(10, 0, 10, 7)).toBe(10);
  });
});

describe('normalizeConfig', () => {
  it('returns DEFAULT_CONFIG values for empty object', () => {
    expect(normalizeConfig({})).toEqual({
      ...DEFAULT_CONFIG,
      context_window: 50,
      auto_compress: false,
      compress_keep_recent: 10,
    });
  });

  it('preserves valid complete config', () => {
    const input = {
      model: 'gpt-4o-mini',
      temperature: 1.5,
      presence_penalty: 1,
      frequency_penalty: -1,
      context_window: 120,
      top_p: 0.8,
    };
    expect(normalizeConfig(input)).toEqual({
      ...input,
      auto_compress: false,
      compress_keep_recent: 10,
    });
  });

  it('falls back to default model for empty string', () => {
    expect(normalizeConfig({ model: '' }).model).toBe(DEFAULT_CONFIG.model);
  });

  it('falls back to default model for whitespace-only string', () => {
    expect(normalizeConfig({ model: '   ' }).model).toBe(DEFAULT_CONFIG.model);
  });

  it('trims model string', () => {
    expect(normalizeConfig({ model: '  gpt-4o-mini  ' }).model).toBe('gpt-4o-mini');
  });

  it('clamps temperature to [0, 2]', () => {
    expect(normalizeConfig({ temperature: 3 }).temperature).toBe(2);
    expect(normalizeConfig({ temperature: -1 }).temperature).toBe(0);
  });

  it('excludes top_p when undefined', () => {
    const result = normalizeConfig({ top_p: undefined });
    expect('top_p' in result).toBe(false);
  });

  it('includes top_p when valid', () => {
    const result = normalizeConfig({ top_p: 0.6 });
    expect(result.top_p).toBe(0.6);
  });

  it('defaults context_window to 50', () => {
    expect(normalizeConfig({}).context_window).toBe(50);
  });
});

describe('getConversationPath', () => {
  it('returns path for 10-digit id', () => {
    const result = getConversationPath('1234567890');
    expect(typeof result).toBe('string');
    expect(result).toMatch(/1234567890\.json$/);
  });

  it('returns path for 16-digit id', () => {
    const result = getConversationPath('1234567890123456');
    expect(typeof result).toBe('string');
    expect(result).toMatch(/1234567890123456\.json$/);
  });

  it('returns null for 9-digit id', () => {
    expect(getConversationPath('123456789')).toBeNull();
  });

  it('returns null for 17-digit id', () => {
    expect(getConversationPath('12345678901234567')).toBeNull();
  });

  it('returns null for id with letters', () => {
    expect(getConversationPath('12345abcde')).toBeNull();
  });

  it('returns null for null or undefined', () => {
    expect(getConversationPath(null)).toBeNull();
    expect(getConversationPath(undefined)).toBeNull();
  });
});

describe('atomicWrite', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomicwrite-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes content and reads back correctly', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    await atomicWrite(filePath, '{"hello":"world"}');
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toBe('{"hello":"world"}');
  });

  it('leaves no .tmp files after write', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    await atomicWrite(filePath, 'data');
    const files = await fsp.readdir(tmpDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('overwrites existing file completely', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    await atomicWrite(filePath, 'original content');
    await atomicWrite(filePath, 'new content');
    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toBe('new content');
  });
});

describe('createMutex', () => {
  it('serializes async tasks in FIFO order', async () => {
    const withLock = createMutex();
    const order = [];

    const p1 = withLock(async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push('first');
    });
    const p2 = withLock(async () => {
      order.push('second');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['first', 'second']);
  });

  it('does not deadlock when first task throws', async () => {
    const withLock = createMutex();
    const order = [];

    const p1 = withLock(async () => {
      order.push('first');
      throw new Error('boom');
    }).catch(() => {});

    const p2 = withLock(async () => {
      order.push('second');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['first', 'second']);
  });

  it('passes through return value', async () => {
    const withLock = createMutex();
    const result = await withLock(() => 42);
    expect(result).toBe(42);
  });
});

// ===== readConfig =====

describe('readConfig', () => {
  const { readConfig, normalizeConfig } = require('../lib/config');
  let readFileSpy;
  beforeEach(() => { readFileSpy = vi.spyOn(fsp, 'readFile'); });
  afterEach(() => { readFileSpy.mockRestore(); });

  it('正常读取并 normalize', async () => {
    readFileSpy.mockResolvedValue(JSON.stringify({ model: 'gpt-4o-mini', temperature: 1.5 }));
    const cfg = await readConfig();
    expect(cfg.model).toBe('gpt-4o-mini');
    expect(cfg.temperature).toBe(1.5);
    // normalize 添加了 context_window 默认值
    expect(cfg).toHaveProperty('context_window');
  });

  it('ENOENT → 返回默认 config', async () => {
    readFileSpy.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const cfg = await readConfig();
    expect(cfg.model).toBe('gpt-4o');
  });

  it('损坏 JSON → 返回默认 config', async () => {
    readFileSpy.mockResolvedValue('not json{{{');
    const cfg = await readConfig();
    expect(cfg.model).toBe('gpt-4o');
  });

  it('非 ENOENT 异常 → 返回默认 config（不抛）', async () => {
    readFileSpy.mockRejectedValue(new Error('EPERM'));
    const cfg = await readConfig();
    expect(cfg.model).toBe('gpt-4o');
  });
});

// ===== saveConfig =====

describe('saveConfig', () => {
  const { saveConfig } = require('../lib/config');
  let openSpy, renameSpy, unlinkSpy;

  beforeEach(() => {
    // Mock 底层 fs 操作防止真实写入（saveConfig 内部直接调 atomicWrite，无法 spy exports）
    openSpy = vi.spyOn(fsp, 'open').mockResolvedValue({
      writeFile: vi.fn().mockResolvedValue(),
      sync: vi.fn().mockResolvedValue(),
      close: vi.fn().mockResolvedValue(),
    });
    renameSpy = vi.spyOn(fsp, 'rename').mockResolvedValue();
    // Windows 上 atomicWrite 在 rename 前调 unlink
    unlinkSpy = vi.spyOn(fsp, 'unlink').mockResolvedValue();
  });
  afterEach(() => { openSpy.mockRestore(); renameSpy.mockRestore(); unlinkSpy.mockRestore(); });

  it('正常写入并返回 normalized', async () => {
    const result = await saveConfig({ model: 'gpt-4o-mini', temperature: 0.5 });
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.temperature).toBe(0.5);
    expect(openSpy).toHaveBeenCalled();
  });

  it('返回的 config 已 normalize', async () => {
    const result = await saveConfig({ temperature: 99 });
    expect(result.temperature).toBe(2); // clamped
  });

  it('写入的 JSON 包含所有必要字段', async () => {
    const result = await saveConfig({ model: 'test-model' });
    expect(result).toHaveProperty('context_window');
    expect(result).toHaveProperty('temperature');
  });
});

// ===== pruneBackups =====

describe('pruneBackups', () => {
  const { pruneBackups } = require('../lib/config');
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'prune-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('≤ keep 个文件 → 不删', async () => {
    for (let i = 0; i < 3; i++) {
      await fsp.writeFile(path.join(tmpDir, `${i}.json`), '{}');
    }
    await pruneBackups(tmpDir, 5);
    const files = await fsp.readdir(tmpDir);
    expect(files).toHaveLength(3);
  });

  it('超过 keep → 删最早的', async () => {
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(path.join(tmpDir, `${String(i).padStart(3, '0')}.json`), '{}');
    }
    await pruneBackups(tmpDir, 3);
    const files = (await fsp.readdir(tmpDir)).sort();
    expect(files).toHaveLength(3);
    // 保留的是最后3个: 002.json, 003.json, 004.json
    expect(files[0]).toBe('002.json');
  });

  it('只处理 .json 文件', async () => {
    await fsp.writeFile(path.join(tmpDir, 'a.json'), '{}');
    await fsp.writeFile(path.join(tmpDir, 'b.json'), '{}');
    await fsp.writeFile(path.join(tmpDir, 'readme.txt'), 'hi');
    await pruneBackups(tmpDir, 1);
    const files = await fsp.readdir(tmpDir);
    // 1 json kept + readme.txt
    expect(files).toHaveLength(2);
    expect(files).toContain('readme.txt');
  });

  it('目录不存在 → 不抛错', async () => {
    await expect(pruneBackups('/nonexistent/path', 5)).resolves.not.toThrow();
  });
});

// ===== rebuildIndex =====

describe('rebuildIndex', () => {
  const { rebuildIndex, CONVERSATIONS_DIR } = require('../lib/config');
  let readdirSpy, readFileSpy, openSpy, renameSpy, unlinkSpy;

  beforeEach(() => {
    readdirSpy = vi.spyOn(fsp, 'readdir');
    readFileSpy = vi.spyOn(fsp, 'readFile');
    // rebuildIndex 内部调 atomicWrite（闭包引用），spy exports 无效，需 mock 底层 fs
    openSpy = vi.spyOn(fsp, 'open').mockResolvedValue({
      writeFile: vi.fn().mockResolvedValue(),
      sync: vi.fn().mockResolvedValue(),
      close: vi.fn().mockResolvedValue(),
    });
    renameSpy = vi.spyOn(fsp, 'rename').mockResolvedValue();
    unlinkSpy = vi.spyOn(fsp, 'unlink').mockResolvedValue();
  });
  afterEach(() => { readdirSpy.mockRestore(); readFileSpy.mockRestore(); openSpy.mockRestore(); renameSpy.mockRestore(); unlinkSpy.mockRestore(); });

  it('空目录 → 空索引', async () => {
    readdirSpy.mockResolvedValue([]);
    const index = await rebuildIndex();
    expect(index).toEqual({});
  });

  it('有文件 → 构建索引', async () => {
    readdirSpy.mockResolvedValue(['123.json']);
    readFileSpy.mockResolvedValue(JSON.stringify({ id: '123', title: 'Test', messages: [{ role: 'user', content: 'hi' }] }));
    const index = await rebuildIndex();
    expect(index['123']).toBeDefined();
    expect(index['123'].title).toBe('Test');
    expect(index['123'].messageCount).toBe(1);
  });

  it('跳过 _index.json', async () => {
    readdirSpy.mockResolvedValue(['_index.json', '123.json']);
    readFileSpy.mockResolvedValue(JSON.stringify({ id: '123', title: 'T', messages: [] }));
    const index = await rebuildIndex();
    expect(Object.keys(index)).toEqual(['123']);
  });

  it('损坏文件跳过不报错', async () => {
    readdirSpy.mockResolvedValue(['bad.json', 'good.json']);
    readFileSpy.mockImplementation((p) => {
      if (p.includes('bad')) return Promise.reject(new Error('corrupt'));
      return Promise.resolve(JSON.stringify({ id: 'good', title: 'G', messages: [] }));
    });
    const index = await rebuildIndex();
    expect(Object.keys(index)).toEqual(['good']);
  });
});
