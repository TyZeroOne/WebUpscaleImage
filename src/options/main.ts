import '@/ui/styles/base.css'
import { detectCapabilities, recommendLevel } from '@/core/device'
import { applyI18n, t } from '@/core/i18n'
import { createLogger } from '@/core/log'
import { type QualityPreference, getSettings, patchSettings } from '@/core/settings'

/**
 * Страница настроек.
 *
 * На этапе 6 она впервые начала влиять на поведение: выбор уровня качества,
 * подмена картинки на странице и подробные логи.
 *
 * Здесь же показывается, что расширение думает об этом устройстве. Это
 * не украшение: без этих строк выбор «автоматически» — чёрный ящик,
 * а пользователю, у которого не работает нейросеть, нечего сообщить
 * в баг-репорте.
 */

const log = createLogger('options')

const LEVEL_KEYS: Record<string, string> = {
  fast: 'levelNameFast',
  balanced: 'levelNameBalanced',
  quality: 'levelNameQuality',
}

function flashSaved(node: Element | null): void {
  if (!(node instanceof HTMLElement)) return
  node.textContent = t('optSaved')
  node.className = 'save-state ie-ok'
  setTimeout(() => {
    node.textContent = ''
    node.className = 'save-state'
  }, 1500)
}

/** Отметка «сохранено» ищется рядом с самим полем, а не по одному общему id. */
function saveStateFor(input: Element): Element | null {
  return input.closest('li')?.querySelector('.save-state') ?? null
}

function setText(id: string, text: string, state?: 'ok' | 'fail'): void {
  const node = document.getElementById(id)
  if (!node) return
  node.textContent = text
  node.className = state ? `ie-${state}` : ''
}

async function renderDevice(): Promise<void> {
  const capabilities = await detectCapabilities()
  setText(
    'cap-webgpu',
    capabilities.webgpu ? (capabilities.webgpuAdapter ?? t('capYes')) : t('capNo'),
    capabilities.webgpu ? 'ok' : 'fail',
  )
  setText(
    'cap-simd',
    capabilities.wasmSimd ? t('capYes') : t('capNo'),
    capabilities.wasmSimd ? 'ok' : 'fail',
  )
  setText('cap-cores', String(capabilities.logicalCores))
  setText(
    'cap-memory',
    capabilities.memoryGb === null ? t('capUnknown') : t('capMemoryValue', capabilities.memoryGb),
  )

  // Подсказка у варианта «автоматически»: что именно он сейчас означает.
  const hint = document.getElementById('auto-hint')
  if (hint) {
    const level = recommendLevel(capabilities)
    hint.textContent = t('levelAutoResolved', t(LEVEL_KEYS[level] ?? level))
  }
}

async function init(): Promise<void> {
  applyI18n()
  const version = document.getElementById('version')
  if (version) version.textContent = `v${chrome.runtime.getManifest().version}`

  const settings = await getSettings()

  const qualityInputs = document.querySelectorAll<HTMLInputElement>('input[name="quality"]')
  for (const input of qualityInputs) {
    input.checked = input.value === settings.quality
    input.addEventListener('change', () => {
      if (!input.checked) return
      void patchSettings({ quality: input.value as QualityPreference }).catch((error: unknown) =>
        log.error('Не удалось сохранить уровень:', error),
      )
    })
  }

  const toggles: [string, keyof typeof settings][] = [
    ['replace-on-page', 'replaceOnPage'],
    ['verbose-logging', 'verboseLogging'],
  ]
  for (const [id, key] of toggles) {
    const input = document.getElementById(id)
    if (!(input instanceof HTMLInputElement)) continue
    input.checked = Boolean(settings[key])
    input.addEventListener('change', () => {
      void patchSettings({ [key]: input.checked })
        .then(() => flashSaved(saveStateFor(input)))
        .catch((error: unknown) => log.error('Не удалось сохранить настройку:', error))
    })
  }

  await renderDevice()
}

void init()
