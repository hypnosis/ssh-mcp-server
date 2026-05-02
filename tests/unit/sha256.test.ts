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
});
