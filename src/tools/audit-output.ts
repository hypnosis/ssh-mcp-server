/**
 * Разбор ответов аудита: что уезжает клиенту и чем это объявлено.
 *
 * Тип и схема лежат рядом намеренно. Клиент сверяет пришедшее с объявленным и
 * на расхождении возвращает ошибку протокола вместо ответа, поэтому схема —
 * не описание намерений, а обещание, которое обязано совпадать с типом строка
 * в строку.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

/**
 * Разделы обзора. Отсутствующее поле значит «раздел не запрашивали»:
 * пустое значение в невыбранном разделе читается как факт о сервере.
 */
export interface BaselineResult {
  hostname?: string;
  uptime?: string;
  date_utc?: string;
  os?: string;
  kernel?: string;
  disk?: Array<{ filesystem: string; size: string; used: string; avail: string; pct: number; mount: string }>;
  memory?: { total: string; used: string; free: string; available: string };
  load?: string;
  net?: {
    listeners: Array<{ proto: string; address: string; pid_program: string }>;
    interfaces: string[];
  };
  ssh?: {
    port: string;
    permit_root_login: string;
    password_auth: string;
    pubkey_auth: string;
  };
  services?: {
    failed: string[];
    running_count: number;
  };
  /** `null` — раздел спрашивали, докера на сервере нет; поля нет — не спрашивали */
  docker?: {
    containers: Array<{ id: string; image: string; status: string; names: string }>;
    df: string;
  } | null;
  /** У каждого межсетевого экрана три исхода: нет его, не дали посмотреть, посмотрели */
  firewall?: {
    ufw: { status: 'not_installed' | 'no_access' | 'read'; active?: boolean; text: string };
    iptables: { status: 'not_installed' | 'no_access' | 'read'; rules?: number };
  };
  updates?: {
    upgradable: number;
    reboot_required: boolean;
  };
  /**
   * Разделы, которые проверить было нечем: команды нет на сервере или она
   * ничего не вернула. Пустой раздел и непроверенный раздел выглядят
   * одинаково («disk:» без строк, «listeners (0)»), а значат разное —
   * без этого списка отчёт объявляет отсутствие данных отсутствием проблем.
   */
  unavailable: string[];
  red_flags: { critical: string[]; warning: string[]; ok: string[] };
}

/**
 * Итог проверки сертификата.
 *
 * `null` в поле — «прочитать не удалось», а не «в сертификате этого нет».
 * Схема допускает его везде, где допускает тип: иначе непрочитанный
 * сертификат — обычный для сервера без TLS исход — приезжал бы к клиенту
 * ошибкой протокола.
 */
export interface TlsCheckResult {
  domain: string;
  port: number;
  not_after: string | null;
  days_until_expiry: number | null;
  san_includes_hostname: boolean | null;
  san_text: string;
  issuer: string | null;
  renew_hook_configured: boolean | null;
  renew_hook_evidence: string;
}

const STRING_LIST = { type: 'array', items: { type: 'string' } };

const FIREWALL_STATUS = ['not_installed', 'no_access', 'read'];

export const BASELINE_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    hostname: { type: 'string' },
    uptime: { type: 'string' },
    date_utc: { type: 'string' },
    os: { type: 'string' },
    kernel: { type: 'string' },
    load: { type: 'string' },
    disk: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filesystem: { type: 'string' },
          size: { type: 'string' },
          used: { type: 'string' },
          avail: { type: 'string' },
          pct: { type: 'number' },
          mount: { type: 'string' },
        },
        required: ['filesystem', 'size', 'used', 'avail', 'pct', 'mount'],
      },
    },
    memory: {
      type: 'object',
      properties: {
        total: { type: 'string' },
        used: { type: 'string' },
        free: { type: 'string' },
        available: { type: 'string' },
      },
      required: ['total', 'used', 'free', 'available'],
    },
    net: {
      type: 'object',
      properties: {
        listeners: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              proto: { type: 'string' },
              address: { type: 'string' },
              pid_program: { type: 'string' },
            },
            required: ['proto', 'address', 'pid_program'],
          },
        },
        interfaces: STRING_LIST,
      },
      required: ['listeners', 'interfaces'],
    },
    ssh: {
      type: 'object',
      properties: {
        port: { type: 'string' },
        permit_root_login: { type: 'string' },
        password_auth: { type: 'string' },
        pubkey_auth: { type: 'string' },
      },
      required: ['port', 'permit_root_login', 'password_auth', 'pubkey_auth'],
    },
    services: {
      type: 'object',
      properties: {
        failed: STRING_LIST,
        running_count: { type: 'number' },
      },
      required: ['failed', 'running_count'],
    },
    docker: {
      type: ['object', 'null'],
      properties: {
        containers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              image: { type: 'string' },
              status: { type: 'string' },
              names: { type: 'string' },
            },
            required: ['id', 'image', 'status', 'names'],
          },
        },
        df: { type: 'string' },
      },
    },
    firewall: {
      type: 'object',
      properties: {
        ufw: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: FIREWALL_STATUS },
            active: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['status', 'text'],
        },
        iptables: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: FIREWALL_STATUS },
            rules: { type: 'number' },
          },
          required: ['status'],
        },
      },
      required: ['ufw', 'iptables'],
    },
    updates: {
      type: 'object',
      properties: {
        upgradable: { type: 'number' },
        reboot_required: { type: 'boolean' },
      },
      required: ['upgradable', 'reboot_required'],
    },
    unavailable: STRING_LIST,
    red_flags: {
      type: 'object',
      properties: { critical: STRING_LIST, warning: STRING_LIST, ok: STRING_LIST },
      required: ['critical', 'warning', 'ok'],
    },
  },
  required: ['unavailable', 'red_flags'],
};

export const TLS_CHECK_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    port: { type: 'number' },
    not_after: { type: ['string', 'null'] },
    days_until_expiry: { type: ['number', 'null'] },
    san_includes_hostname: { type: ['boolean', 'null'] },
    san_text: { type: 'string' },
    issuer: { type: ['string', 'null'] },
    renew_hook_configured: { type: ['boolean', 'null'] },
    renew_hook_evidence: { type: 'string' },
  },
  required: [
    'domain',
    'port',
    'not_after',
    'days_until_expiry',
    'san_includes_hostname',
    'san_text',
    'issuer',
    'renew_hook_configured',
    'renew_hook_evidence',
  ],
};
