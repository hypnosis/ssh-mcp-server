/**
 * Shapes of audit responses: what travels to the client and what declares it.
 *
 * The type and the schema live side by side on purpose. The client checks
 * what arrives against what was declared and, on a mismatch, returns a
 * protocol error instead of the answer — so the schema is not a description
 * of intent but a promise that must match the type line for line.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DuEntry } from '../utils/du-lines.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;

/**
 * Overview sections. A missing field means "section not requested": an empty
 * value in an unselected section would otherwise read as a fact about the server.
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
  /** `null` — the section was requested, there is no docker on the server; field absent — not requested */
  docker?: {
    containers: Array<{ id: string; image: string; status: string; names: string }>;
    df: string;
  } | null;
  /** Each firewall has three outcomes: absent, not allowed to look, checked */
  firewall?: {
    ufw: { status: 'not_installed' | 'no_access' | 'read'; active?: boolean; text: string };
    iptables: { status: 'not_installed' | 'no_access' | 'read'; rules?: number };
  };
  updates?: {
    upgradable: number;
    reboot_required: boolean;
  };
  /**
   * Sections that had nothing to check them with: the command is absent from
   * the server, or it returned nothing. An empty section and an unchecked
   * section look the same ("disk:" with no rows, "listeners (0)") but mean
   * different things — without this list the report would announce a lack of
   * data as a lack of problems.
   */
  unavailable: string[];
  red_flags: { critical: string[]; warning: string[]; ok: string[] };
}

/**
 * Certificate check result.
 *
 * `null` in a field means "could not be read", not "the certificate lacks
 * this". The schema allows it wherever the type allows it: otherwise an
 * unread certificate — an ordinary outcome for a server without TLS — would
 * reach the client as a protocol error.
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

/**
 * Disk usage broken down.
 *
 * A section that could not be measured is named in `unavailable` instead of
 * arriving empty: an empty list of largest entries and a directory that was
 * never read look identical, and one of them is a lack of data, not a lack of
 * problems. `null` in `docker` or `journald` means the server has neither —
 * that is an answer, not a gap.
 */
export interface DiskBreakdownResult {
  filesystems: Array<{
    filesystem: string;
    type: string;
    size: string;
    used: string;
    avail: string;
    pct: number;
    mount: string;
  }>;
  largest: Array<{ path: string; entries: DuEntry[] }>;
  var_log: DuEntry[];
  cache: DuEntry[];
  docker: string | null;
  journald: string | null;
  unavailable: string[];
}

/**
 * State of one service.
 *
 * `checked` is the only outcome where the fields below carry a measurement.
 * `no_systemd` — there was nobody to ask on that server; `no_unit` — the
 * server answered that no such service exists. Both leave the fields `null`,
 * because a service that was not measured must not read as a service that is
 * stopped.
 */
export interface ServiceStatusResult {
  unit: string;
  outcome: 'checked' | 'no_systemd' | 'no_unit';
  enabled: string | null;
  active_state: string | null;
  sub_state: string | null;
  restart: string | null;
  restart_after: string | null;
  status_head: string;
  recent_log: string;
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

const DU_ENTRIES = {
  type: 'array',
  items: {
    type: 'object',
    properties: { size: { type: 'string' }, path: { type: 'string' } },
    required: ['size', 'path'],
  },
};

export const DISK_BREAKDOWN_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    filesystems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filesystem: { type: 'string' },
          type: { type: 'string' },
          size: { type: 'string' },
          used: { type: 'string' },
          avail: { type: 'string' },
          pct: { type: 'number' },
          mount: { type: 'string' },
        },
        required: ['filesystem', 'type', 'size', 'used', 'avail', 'pct', 'mount'],
      },
    },
    largest: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, entries: DU_ENTRIES },
        required: ['path', 'entries'],
      },
    },
    var_log: DU_ENTRIES,
    cache: DU_ENTRIES,
    docker: { type: ['string', 'null'] },
    journald: { type: ['string', 'null'] },
    unavailable: STRING_LIST,
  },
  required: [
    'filesystems',
    'largest',
    'var_log',
    'cache',
    'docker',
    'journald',
    'unavailable',
  ],
};

export const SERVICE_STATUS_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    unit: { type: 'string' },
    outcome: { type: 'string', enum: ['checked', 'no_systemd', 'no_unit'] },
    enabled: { type: ['string', 'null'] },
    active_state: { type: ['string', 'null'] },
    sub_state: { type: ['string', 'null'] },
    restart: { type: ['string', 'null'] },
    restart_after: { type: ['string', 'null'] },
    status_head: { type: 'string' },
    recent_log: { type: 'string' },
  },
  required: [
    'unit',
    'outcome',
    'enabled',
    'active_state',
    'sub_state',
    'restart',
    'restart_after',
    'status_head',
    'recent_log',
  ],
};
