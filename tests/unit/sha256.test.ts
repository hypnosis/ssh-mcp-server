/**
 * Unit tests for sha256 helpers
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  sha256OfFile,
  sha256OfBuffer,
  buildRemoteSha256Command,
  parseRemoteSha256,
  buildSha256Manifest,
  parseSha256CheckFailures,
  SHA256_BATCH_CHECK_COMMAND,
} from '../../src/utils/sha256.js';

describe('sha256 helpers', () => {
  describe('sha256OfBuffer', () => {
    it('hashes empty buffer to known value', () => {
      const hex = sha256OfBuffer(Buffer.alloc(0));
      expect(hex).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
    });

    it('hashes "abc" to known value', () => {
      const hex = sha256OfBuffer(Buffer.from('abc'));
      expect(hex).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    });
  });

  describe('sha256OfFile', () => {
    it('matches sha256OfBuffer for the same content', async () => {
      const content = Buffer.from('Hello SSH MCP\n');
      const path = join(tmpdir(), `ssh-mcp-test-${Date.now()}.bin`);
      writeFileSync(path, content);
      try {
        const fileHash = await sha256OfFile(path);
        const bufHash = sha256OfBuffer(content);
        expect(fileHash).toBe(bufHash);
      } finally {
        unlinkSync(path);
      }
    });
  });

  describe('buildRemoteSha256Command', () => {
    it('embeds the quoted path verbatim', () => {
      const cmd = buildRemoteSha256Command(`'/tmp/file.bin'`);
      expect(cmd).toContain(`sha256sum '/tmp/file.bin'`);
      expect(cmd).toContain(`openssl dgst -sha256 '/tmp/file.bin'`);
      expect(cmd).toContain('NO_SHA256_TOOL');
    });
  });

  describe('parseRemoteSha256', () => {
    it('parses sha256sum output (hex + filename)', () => {
      const out = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  /tmp/x\n';
      expect(parseRemoteSha256(out)).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    });

    it('parses openssl-style line (already pre-extracted to last field)', () => {
      const out = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
      expect(parseRemoteSha256(out)).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    });

    it('rejects non-hex output', () => {
      expect(() => parseRemoteSha256('NO_SHA256_TOOL')).toThrow(
        /Invalid remote sha256/
      );
    });

    it('lowercases uppercase hex', () => {
      const upper = 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD';
      expect(parseRemoteSha256(upper)).toBe(upper.toLowerCase());
    });
  });

  describe('buildSha256Manifest', () => {
    const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

    it('пишет по строке на файл в формате sha256sum', () => {
      const manifest = buildSha256Manifest([
        { hash: HASH, path: '/srv/app/index.js' },
        { hash: HASH, path: '/srv/app/conf/app.ini' },
      ]);

      expect(manifest).toBe(
        `${HASH}  /srv/app/index.js\n${HASH}  /srv/app/conf/app.ini\n`
      );
    });

    it('пробелы в имени не требуют экранирования', () => {
      const manifest = buildSha256Manifest([{ hash: HASH, path: '/srv/my app/file.txt' }]);

      expect(manifest).toBe(`${HASH}  /srv/my app/file.txt\n`);
    });

    it('обратный слэш в имени экранируется и строка помечается ведущим слэшем', () => {
      const manifest = buildSha256Manifest([{ hash: HASH, path: '/srv/we\\ird' }]);

      // Формат coreutils: строка начинается с "\", внутри "\" удваивается
      expect(manifest).toBe(`\\${HASH}  /srv/we\\\\ird\n`);
    });

    it('перевод строки в имени не разрывает манифест', () => {
      const manifest = buildSha256Manifest([{ hash: HASH, path: '/srv/two\nlines' }]);

      expect(manifest.split('\n')).toHaveLength(2);
      expect(manifest).toContain('two\\nlines');
    });
  });

  describe('SHA256_BATCH_CHECK_COMMAND', () => {
    it('читает манифест со stdin и сообщает об отсутствии инструмента', () => {
      expect(SHA256_BATCH_CHECK_COMMAND).toContain('sha256sum -c');
      expect(SHA256_BATCH_CHECK_COMMAND).toContain('NO_SHA256_TOOL');
    });
  });

  describe('parseSha256CheckFailures', () => {
    it('собирает пути файлов, не прошедших проверку', () => {
      const out = '/srv/app/index.js: FAILED\n/srv/app/conf/app.ini: FAILED open or read\n';

      expect(parseSha256CheckFailures(out)).toEqual([
        '/srv/app/index.js',
        '/srv/app/conf/app.ini',
      ]);
    });

    it('успешные строки и предупреждения не считаются провалом', () => {
      const out = '/srv/app/index.js: OK\nsha256sum: WARNING: 1 line is improperly formatted\n';

      expect(parseSha256CheckFailures(out)).toEqual([]);
    });

    it('двоеточие в имени файла не ломает разбор', () => {
      expect(parseSha256CheckFailures('/srv/log:2026-08-02.txt: FAILED')).toEqual([
        '/srv/log:2026-08-02.txt',
      ]);
    });
  });
});
