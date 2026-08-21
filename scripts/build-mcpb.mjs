#!/usr/bin/env node
/**
 * Собирает MCPB-бандл — тот вид поставки, который принимают Smithery и клиенты
 * с установкой в один клик.
 *
 * Отличие от npm: бандл несёт с собой собранный код и рабочие зависимости, поэтому
 * его нужно пересобирать на каждый релиз. Версия и описание берутся из package.json —
 * ещё одного места, где версия может разойтись, здесь нет намеренно.
 *
 *   npm run build:mcpb        # releases/ssh-mcp-server-<версия>.mcpb
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'releases');
const MANIFEST_VERSION = '0.3';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
  console.error('Нет dist/index.js — сначала `npm run build`.');
  process.exit(1);
}

// Собранный код и зависимости уезжают в бандл, исходники и тесты — нет.
const staging = mkdtempSync(join(tmpdir(), 'ssh-mcp-mcpb-'));
try {
  cpSync(join(ROOT, 'dist'), join(staging, 'dist'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
    cpSync(join(ROOT, file), join(staging, file));
  }
  cpSync(join(ROOT, 'assets', 'icon-512.png'), join(staging, 'icon.png'));

  // Только рабочие зависимости: с dev-набором бандл раздувается на порядок.
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: staging, stdio: 'ignore' });

  const manifest = {
    manifest_version: MANIFEST_VERSION,
    name: 'ssh-mcp-server',
    display_name: 'SSH MCP Server',
    version: pkg.version,
    description: pkg.description,
    author: { name: 'hypnosis', url: 'https://github.com/hypnosis' },
    repository: { type: 'git', url: 'https://github.com/hypnosis/ssh-mcp-server' },
    homepage: 'https://github.com/hypnosis/ssh-mcp-server#readme',
    documentation: 'https://github.com/hypnosis/ssh-mcp-server/blob/main/docs/tools.md',
    icon: 'icon.png',
    license: pkg.license,
    keywords: pkg.keywords,
    server: {
      type: 'node',
      entry_point: 'dist/index.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/dist/index.js'],
        env: {
          SSH_PROFILES_FILE: '${user_config.ssh_profiles_file}',
          SSH_MCP_LOG_LEVEL: '${user_config.log_level}',
        },
      },
    },
    user_config: {
      ssh_profiles_file: {
        type: 'file',
        title: 'SSH profiles file',
        description: 'JSON file describing the machines this agent may reach.',
        required: false,
      },
      log_level: {
        type: 'string',
        title: 'Log level',
        description: 'error, warn, info or debug.',
        default: 'info',
        required: false,
      },
    },
    // Списка инструментов здесь нет намеренно: схема манифеста разрешает в нём
    // только имя и описание, а приёмник Smithery требует у каждого inputSchema и
    // отвергает бандл без него. Подробности — docs/listing.md.
    compatibility: {
      runtimes: { node: pkg.engines?.node ?? '>=18.0.0' },
    },
  };
  writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  mkdirSync(OUT_DIR, { recursive: true });
  const target = join(OUT_DIR, `ssh-mcp-server-${pkg.version}.mcpb`);
  rmSync(target, { force: true });
  execFileSync('npx', ['--yes', '@anthropic-ai/mcpb@2', 'pack', staging, target], { stdio: 'inherit' });

  console.log('');
  console.log(`Бандл: ${target}`);
  console.log('Публикация на Smithery — отдельным шагом, с их учётной записью:');
  console.log(`  npx @smithery/cli mcp publish ${target} -n hypnosis/ssh-mcp-server`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
