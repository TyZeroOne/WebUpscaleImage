import { createLogger, setVerboseLogging } from '@/core/log'
import { registerMessageHandlers } from '@/core/messaging'
import { getSettings, onSettingsChanged } from '@/core/settings'
import { registerContextMenu } from './context-menu'
import { startDevReloadWatcher } from './dev-reload'

/**
 * Service worker расширения — единственная «всегда доступная» точка,
 * через которую общаются вкладки, popup и (начиная с этапа 4) offscreen-документ.
 *
 * ГЛАВНОЕ ПРАВИЛО MV3: слушатели событий регистрируются СИНХРОННО на верхнем
 * уровне модуля. Service worker выгружается после ~30 секунд простоя и
 * поднимается заново на входящее событие. Если повесить слушатель внутри
 * промиса или таймера, к моменту его регистрации событие уже будет потеряно.
 *
 * Отсюда же следует, что здесь нельзя держать состояние в переменных модуля:
 * после выгрузки оно исчезнет. Всё, что должно пережить выгрузку, идёт
 * в chrome.storage (session или local).
 */

const log = createLogger('background')

// --- слушатели (только синхронная регистрация) ------------------------------

registerMessageHandlers({
  PING: (payload) => ({
    pong: true,
    roundTripStartedAt: payload.sentAt,
    version: chrome.runtime.getManifest().version,
  }),

  PAGE_SCAN: (payload, sender) => {
    log.debug(
      `Вкладка ${sender.tab?.id ?? '?'} (${payload.url}): ` +
        `изображений ${payload.images}, видео ${payload.videos}`,
    )
    return { received: true }
  },

  /**
   * На этапе 2 обработка выполняется в content script, а сюда приходит только
   * отчёт: центральный лог удобен, когда надо понять, что вообще происходило
   * во вкладках. На этапе 4 это же сообщение станет точкой, откуда задача
   * уходит в offscreen-документ и Worker — форма запроса для этого уже готова.
   */
  ENHANCE_IMAGE: (payload, sender) => {
    log.info(
      `Запрос на улучшение из вкладки ${sender.tab?.id ?? '?'} (${payload.trigger}): ` +
        `${payload.naturalWidth}×${payload.naturalHeight}, ${payload.sourceUrl}`,
    )
    return { received: true }
  },
})

registerContextMenu()

chrome.runtime.onInstalled.addListener((details) => {
  log.info(`onInstalled: ${details.reason}, версия ${chrome.runtime.getManifest().version}`)
})

onSettingsChanged((settings) => {
  setVerboseLogging(import.meta.env.DEV || settings.verboseLogging)
})

// --- асинхронная инициализация (уже после регистрации слушателей) -----------

void getSettings().then((settings) => {
  setVerboseLogging(import.meta.env.DEV || settings.verboseLogging)
  log.info('Service worker запущен')
})

if (import.meta.env.DEV) {
  startDevReloadWatcher()
}
