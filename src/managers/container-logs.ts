/**
 * Where a container keeps its output on the machine.
 *
 * The engine is asked rather than guessed: one `inspect` names the file, the
 * driver and the state. The driver decides whether there is a file to read at
 * all — journald, syslog and the binary `local` driver put the output
 * somewhere this toolset has no reader for, and naming that is the answer, not
 * an empty result that reads as "no errors".
 */

import { logger } from '../utils/logger.js';
import { shellQuote } from '../utils/shell-arg.js';
import type { SSHConfig } from '../utils/ssh-config.js';
import type { SSHExecutor } from './ssh-executor.js';

/** The only driver that leaves a plain file behind */
export const READABLE_DRIVER = 'json-file';

/** Printed instead of the inspect line when the machine has no docker */
const NO_ENGINE = 'SSH_MCP_NO_DOCKER';
/** Printed when docker is absent but podman answers in its place */
const PODMAN_ONLY = 'SSH_MCP_PODMAN_ONLY';

/** Engine refusals that a repeat with sudo would clear */
const NEEDS_ROOT = /permission denied|dial unix|connect: permission/i;
/** Engine refusals that mean the name matched nothing */
const NO_SUCH_CONTAINER = /no such (object|container)|unable to find/i;

/** What the engine answered about one container's log */
export interface ContainerLog {
  /** The name the caller asked about */
  container: string;
  /** The engine that answered — only docker reads back today */
  engine: string;
  /** Logging driver as the engine names it */
  driver: string;
  /** The file the driver writes to */
  path: string;
  /** Container state: a stopped container still has its log */
  status: string;
}

/**
 * The log cannot be read, and the reason is worth showing to the caller.
 *
 * Every case here is a fact about the machine — no engine, no container, no
 * permission, a driver without a file — never a failure of the reader. The
 * way through is added to every refusal alike, by the answer itself.
 */
export class ContainerLogUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ContainerLogUnavailableError';
  }
}

/** One command: is there an engine, and what does it say about this name */
function inspectCommand(container: string): string {
  const name = shellQuote(container);
  const format = '{{.LogPath}}|{{.HostConfig.LogConfig.Type}}|{{.State.Status}}';
  return (
    `if command -v docker >/dev/null 2>&1; then docker inspect --format '${format}' -- ${name}; ` +
    `elif command -v podman >/dev/null 2>&1; then echo ${PODMAN_ONLY}; ` +
    `else echo ${NO_ENGINE}; fi`
  );
}

/** What to say about a refusal the engine worded itself */
function engineRefusal(container: string, text: string, sudo: boolean): string {
  const detail = text.trim().split('\n')[0] || 'no reason given';

  if (NO_SUCH_CONTAINER.test(text)) {
    return `no container named ${container} on this machine — docker answered: ${detail}`;
  }
  if (NEEDS_ROOT.test(text) && !sudo) {
    return (
      `docker refused to answer about ${container} by permissions: ${detail}. ` +
      'The socket belongs to root — repeat with sudo: true'
    );
  }
  return `docker could not answer about ${container}: ${detail}`;
}

/**
 * Ask the engine where the container's output is written.
 *
 * Throws with the reason whenever there is nothing to read — the caller shows
 * that reason instead of an empty answer.
 */
export async function resolveContainerLog(
  executor: SSHExecutor,
  config: SSHConfig,
  container: string,
  options: { sudo?: boolean; signal?: AbortSignal } = {}
): Promise<ContainerLog> {
  const sudo = options.sudo === true;
  const result = await executor.execute(config, inspectCommand(container), {
    sudo,
    idempotent: true,
    signal: options.signal,
  });

  const answer = result.stdout.trim();

  if (answer === NO_ENGINE) {
    throw new ContainerLogUnavailableError(
      `no docker on this machine, so there is nothing to ask about ${container}`
    );
  }
  if (answer === PODMAN_ONLY) {
    throw new ContainerLogUnavailableError(
      'this machine runs podman, not docker, and podman is not read here'
    );
  }
  if (result.exitCode !== 0) {
    throw new ContainerLogUnavailableError(
      engineRefusal(container, result.stderr || result.stdout, sudo)
    );
  }

  const [path, driver, status] = answer.split('|');

  if (!driver) {
    throw new ContainerLogUnavailableError(
      `docker answered about ${container} in a shape this server does not know: ${answer}`
    );
  }
  if (driver !== READABLE_DRIVER) {
    throw new ContainerLogUnavailableError(
      `${container} logs through the "${driver}" driver, which leaves no file to read — ` +
        `only "${READABLE_DRIVER}" does`
    );
  }
  if (!path) {
    throw new ContainerLogUnavailableError(
      `docker named no log file for ${container}, though its driver is "${driver}"`
    );
  }

  logger.info(`[container-logs] ${container}: ${driver} at ${path} (${status || 'state unknown'})`);

  return { container, engine: 'docker', driver, path, status: status || 'unknown' };
}
