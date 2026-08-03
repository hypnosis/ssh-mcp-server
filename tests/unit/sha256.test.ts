/**
 * Unit tests for sha256 helpers
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sha256OfFile, sha256OfBuffer } from '../../src/utils/sha256.js';

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

});
