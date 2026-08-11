import '@/ui/styles/base.css'
import { createLogger } from '@/core/log'
import { getSettings, patchSettings } from '@/core/settings'

/**
 * Страница настроек.
 *
 * На этапе 0 здесь один флаг. Его задача — не столько польза, сколько
 * сквозная проверка: значение сохраняется в chrome.storage.sync, а background
 * и content script подхватывают его через onSettingsChanged. Если галочка
 * работает — значит связка «страница расширения -> storage -> все контексты»
 * собрана правильно, и на этапе 6 останется только добавить полей.
 */

const log = createLogger('options')

const checkbox = document.getElementById('verbose-logging') as HTMLInputElement | null
const saveState = document.getElementById('save-state')
const version = document.getElementById('version')

function flashSaved(): void {
  if (!saveState) return
  saveState.textContent = 'сохранено'
  saveState.className = 'ie-ok'
  setTimeout(() => {
    saveState.textContent = ''
    saveState.className = ''
  }, 1500)
}

async function init(): Promise<void> {
  if (version) version.textContent = `v${chrome.runtime.getManifest().version}`
  if (!checkbox) return

  const settings = await getSettings()
  checkbox.checked = settings.verboseLogging

  checkbox.addEventListener('change', () => {
    void patchSettings({ verboseLogging: checkbox.checked })
      .then(flashSaved)
      .catch((error: unknown) => log.error('Не удалось сохранить настройку:', error))
  })
}

void init()
