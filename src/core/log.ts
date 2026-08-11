/**
 * Единый логгер расширения.
 *
 * Зачем отдельный модуль вместо голого console.log:
 *  - расширение пишет в ЧУЖУЮ консоль (консоль страницы пользователя), поэтому
 *    каждое сообщение обязано быть подписано — иначе непонятно, чьё оно;
 *  - в продакшне отладочный шум должен глушиться, но пользователь должен уметь
 *    включить его обратно, когда присылает баг-репорт (настройка debugLogging);
 *  - console.error не глушится никогда: ошибки нужны всегда.
 */

/** По умолчанию подробные логи включены только в dev-сборке. */
let verbose = import.meta.env.DEV

export function setVerboseLogging(value: boolean): void {
  verbose = value
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * @param scope короткое имя части расширения: 'background', 'content', 'popup'.
 */
export function createLogger(scope: string): Logger {
  const prefix = `[ImageEnhancer:${scope}]`
  return {
    debug: (...args) => { if (verbose) console.debug(prefix, ...args) },
    info: (...args) => { if (verbose) console.info(prefix, ...args) },
    warn: (...args) => { if (verbose) console.warn(prefix, ...args) },
    error: (...args) => { console.error(prefix, ...args) },
  }
}
