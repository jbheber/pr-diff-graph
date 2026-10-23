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
