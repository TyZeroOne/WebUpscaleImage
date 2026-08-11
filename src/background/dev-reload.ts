import { createLogger, type Logger } from '@/core/log'

/**
 * Автоперезагрузка расширения при пересборке (только в dev-сборке).
 *
 * Чего НЕ существует в расширениях: Vite dev server и HMR. Страницы расширения
 * обязаны грузиться со схемы chrome-extension://, а CSP расширений запрещает
 * инлайновые скрипты и eval — то есть весь механизм HMR туда просто не
 * доезжает. Поэтому в разработке используется `vite build --watch`, а
 * «горячесть» делается вручную и грубо: пересобрали — перезагрузили.
 *
 * Как это работает:
 *  1. scripts/build.mjs после каждой пересборки перезаписывает dist/dev-build-id
 *     текущей меткой времени.
 *  2. Этот модуль раз в секунду читает файл (он лежит внутри расширения,
 *     поэтому обычный fetch к chrome-extension://.../dev-build-id работает
 *     без каких-либо разрешений).
 *  3. Как только значение изменилось — запоминаем вкладки, которые нужно
 *     обновить, и вызываем chrome.runtime.reload().
 *
 * Почему вкладки перезагружаются не сразу, а через chrome.storage.session:
 * chrome.runtime.reload() убивает текущий service worker немедленно, код
 * после него не выполняется. Поэтому список вкладок сохраняется ДО перезагрузки,
 * а обновляет их уже новый экземпляр service worker'а при старте.
 * Хранилище session выбрано потому, что живёт в памяти и исчезает вместе
 * с браузером — мусора на диске не остаётся.
 */

const BUILD_ID_PATH = 'dev-build-id'
const POLL_INTERVAL_MS = 1000
const PENDING_TABS_KEY = 'devReloadPendingTabs'

async function readBuildId(): Promise<string | null> {
  try {
    const response = await fetch(chrome.runtime.getURL(BUILD_ID_PATH), { cache: 'no-store' })
    if (!response.ok) return null
    return (await response.text()).trim()
  } catch {
    // Файла нет — значит расширение собрано в продакшн-режиме или сборка
    // ещё не завершилась. И то, и другое не является ошибкой.
    return null
  }
}

/** Перезагружает вкладки, помеченные предыдущим экземпляром worker'а. */
async function flushPendingTabReloads(log: Logger): Promise<void> {
  const stored = await chrome.storage.session.get(PENDING_TABS_KEY)
  const tabIds = stored[PENDING_TABS_KEY] as number[] | undefined
  if (!tabIds?.length) return

  await chrome.storage.session.remove(PENDING_TABS_KEY)
  for (const tabId of tabIds) {
    // Вкладку могли закрыть, пока расширение перезагружалось.
    chrome.tabs.reload(tabId).catch(() => undefined)
  }
  log.info(`Обновлено вкладок после пересборки: ${tabIds.length}`)
}

async function reloadExtension(log: Logger): Promise<void> {
  const tabs = await chrome.tabs.query({})
  const tabIds = tabs
    .filter((tab) => tab.id !== undefined && /^https?:/.test(tab.url ?? ''))
    .map((tab) => tab.id as number)

  await chrome.storage.session.set({ [PENDING_TABS_KEY]: tabIds })
  log.info('Обнаружена новая сборка, перезагружаю расширение')
  chrome.runtime.reload()
}

export function startDevReloadWatcher(): void {
  // Логгер создаётся здесь, а не в области модуля: вызов на верхнем уровне
  // модуля бандлер считает побочным эффектом и оставляет в продакшн-сборке,
  // даже когда весь остальной код файла вырезан. С логгером-параметром
  // модуль исчезает из prod-бандла целиком.
  const log = createLogger('dev-reload')
  void flushPendingTabReloads(log)

  let knownBuildId: string | null = null

  setInterval(() => {
    void (async () => {
      const buildId = await readBuildId()
      if (buildId === null) return

      // Первое чтение только запоминает текущее состояние: иначе расширение
      // уходило бы в перезагрузку сразу после каждого собственного старта.
      if (knownBuildId === null) {
        knownBuildId = buildId
        return
      }
      if (buildId === knownBuildId) return

      knownBuildId = buildId
      await reloadExtension(log)
    })()
  }, POLL_INTERVAL_MS)
}
