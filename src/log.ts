export interface Logger {
  info(m: string): void;
  warn(m: string): void;
  debug(m: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`warning: ${m}`),
  debug: (m) => {
    if (process.env['PR_DIFF_GRAPH_DEBUG']) console.log(`debug: ${m}`);
  },
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
};

/** The `@actions/core` logging functions `actionsLogger` writes through. */
export interface CoreLog {
  info(m: string): void;
  warning(m: string): void;
  debug(m: string): void;
}

/** Logs to the workflow log: warnings become annotations, debug shows with step debugging. */
export function actionsLogger(core: CoreLog): Logger {
  return {
    info: (m) => core.info(m),
    warn: (m) => core.warning(m),
    debug: (m) => core.debug(m),
  };
}
