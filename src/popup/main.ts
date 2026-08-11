import '@/ui/styles/base.css'
import { detectCapabilities, recommendLevel } from '@/core/device'
import { applyI18n, t } from '@/core/i18n'
import { createLogger } from '@/core/log'
import { sendToBackground, sendToTab } from '@/core/messaging'
import { getSettings } from '@/core/settings'

/**
 * Popup — окно, которое открывается по клику на иконку расширения.
 *
 * Важно про жизненный цикл: popup — это полноценный документ, который
 * УНИЧТОЖАЕТСЯ при каждом закрытии. Долгие операции здесь запускать нельзя,
 * они прервутся на полуслове. Поэтому очередь обработки живёт в content
 * script, а popup только показывает состояние и запускает работу.
 */

const log = createLogger('popup')

const LEVEL_KEYS: Record<string, string> = {
  fast: 'levelNameFast',
  balanced: 'levelNameBalanced',
  quality: 'levelNameQuality',
}

function setText(id: string, text: string, state?: 'ok' | 'fail'): void {
  const node = document.getElementById(id)
  if (!node) return
  node.textContent = text
  node.className = state ? `ie-${state}` : ''
}

/**
 * Показывается ДЕЙСТВУЮЩИЙ уровень, а не значение настройки.
 *
 * При выборе «автоматически» строка «авто» ничего не сообщает: пользователь
 * хочет знать, что расширение будет делать, а не как оно это решило.
 */
async function renderQuality(): Promise<void> {
  const settings = await getSettings()
  if (settings.quality !== 'auto') {
    setText('quality', t(LEVEL_KEYS[settings.quality] ?? settings.quality))
    return
  }
  const level = recommendLevel(await detectCapabilities())
  setText('quality', t('levelAutoSuffix', t(LEVEL_KEYS[level] ?? level)))
}

async function renderCapabilities(): Promise<void> {
  const caps = await detectCapabilities()
  setText('webgpu', caps.webgpu ? (caps.webgpuAdapter ?? t('capYes')) : t('capNo'), caps.webgpu ? 'ok' : 'fail')
  setText('wasm-simd', caps.wasmSimd ? t('capYes') : t('capNo'), caps.wasmSimd ? 'ok' : 'fail')
  setText('cores', String(caps.logicalCores))
  setText('memory', caps.memoryGb === null ? t('capUnknown') : t('capMemoryValue', caps.memoryGb))
}

async function pingBackground(): Promise<void> {
  const sentAt = performance.now()
  const response = await sendToBackground('PING', { sentAt })

  if (!response) {
    setText('sw', t('popupSwFail'), 'fail')
    return
  }
  const elapsed = Math.round(performance.now() - response.roundTripStartedAt)
  setText('sw', t('popupSwOk', elapsed), 'ok')
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id
}

async function scanActiveTab(): Promise<void> {
  const tabId = await activeTabId()
  const enhanceButton = document.getElementById('enhance-page') as HTMLButtonElement | null

  const result = tabId === undefined ? null : await sendToTab(tabId, 'SCAN_PAGE', {})
  if (!result) {
    // Штатная ситуация: служебная страница (chrome://, страница настроек,
    // Chrome Web Store), куда content script не внедряется по правилам Chrome.
    setText('page-images', t('popupNoAccess'))
    setText('page-videos', t('popupNoAccess'))
    if (enhanceButton) enhanceButton.disabled = true
    return
  }
  setText('page-images', String(result.images))
  setText('page-videos', String(result.videos))
  // Нечего обрабатывать — кнопка не должна выглядеть рабочей.
  if (enhanceButton) enhanceButton.disabled = result.images === 0
}

/**
 * Запуск режима «вся страница».
 *
 * Popup закрывается сразу после отправки: он уничтожается при любом клике
 * вне себя, и держать его открытым на всё время обработки невозможно.
 * Прогресс показывает панель на самой странице — она переживёт и закрытие
 * popup, и переключение вкладок.
 */
async function startPageEnhance(): Promise<void> {
  const tabId = await activeTabId()
  if (tabId === undefined) return
  await sendToTab(tabId, 'ENHANCE_PAGE', {})
  window.close()
}

applyI18n()
setText('version', `v${chrome.runtime.getManifest().version}`)
void renderCapabilities().catch((error: unknown) => log.error('Детекция устройства:', error))
void renderQuality().catch((error: unknown) => log.error('Уровень качества:', error))
void pingBackground().catch((error: unknown) => log.error('PING не прошёл:', error))
void scanActiveTab().catch((error: unknown) => log.error('Опрос вкладки не прошёл:', error))

document.getElementById('open-options')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage()
})

document.getElementById('enhance-page')?.addEventListener('click', () => {
  void startPageEnhance().catch((error: unknown) => log.error('Запуск не удался:', error))
})
