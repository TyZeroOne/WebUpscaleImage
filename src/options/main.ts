import '@/ui/styles/base.css'
import { detectCapabilities, recommendLevel } from '@/core/device'
import { applyI18n, t } from '@/core/i18n'
import { createLogger } from '@/core/log'
import {
  DEFAULT_SETTINGS,
  type QualityPreference,
  type Settings,
  getSettings,
  patchSettings,
} from '@/core/settings'

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

  /** Группы радиокнопок: имя группы -> ключ настройки. */
  const radioGroups: [string, keyof Settings][] = [
    ['quality', 'quality'],
    ['model', 'model'],
    ['targetMode', 'targetMode'],
  ]
  for (const [group, key] of radioGroups) {
    for (const input of document.querySelectorAll<HTMLInputElement>(`input[name="${group}"]`)) {
      input.checked = input.value === settings[key]
      input.addEventListener('change', () => {
        if (!input.checked) return
        void patchSettings({ [key]: input.value as QualityPreference })
          .then(() => syncTargetVisibility(input.value))
          .catch((error: unknown) => log.error('Не удалось сохранить настройку:', error))
      })
    }
  }

  /**
   * Поле размера и галочка пропуска имеют смысл только при выборе
   * «привести к размеру», а сила эффекта — только у GAN-модели. Скрываем,
   * а не блокируем: неактивное поле выглядит как что-то, что вот-вот
   * заработает, и заставляет искать способ его включить.
   */
  const targetExtra = document.getElementById('target-extra')
  const strengthRow = document.getElementById('strength-row')
  function syncTargetVisibility(value: string): void {
    if (targetExtra && (value === 'auto' || value === 'longest-side')) {
      targetExtra.hidden = value !== 'longest-side'
    }
    if (strengthRow && ['slim', 'medium', 'detailed'].includes(value)) {
      strengthRow.hidden = value !== 'detailed'
    }
  }
  syncTargetVisibility(settings.targetMode)
  syncTargetVisibility(settings.model)

  const strength = document.getElementById('ml-strength')
  const strengthValue = document.getElementById('ml-strength-value')
  if (strength instanceof HTMLInputElement) {
    const render = (value: string): void => {
      if (strengthValue) strengthValue.textContent = `${value}%`
    }
    strength.value = String(settings.mlStrength)
    render(strength.value)
    // Число рядом обновляется на каждое движение ползунка, а сохраняется
    // значение только по отпусканию — иначе запись в хранилище шла бы
    // десятками за одно перетаскивание.
    strength.addEventListener('input', () => render(strength.value))
    strength.addEventListener('change', () => {
      void patchSettings({ mlStrength: Number(strength.value) })
        .then(() => flashSaved(saveStateFor(strength)))
        .catch((error: unknown) => log.error('Не удалось сохранить силу эффекта:', error))
    })
  }

  const targetPx = document.getElementById('target-px')
  if (targetPx instanceof HTMLInputElement) {
    targetPx.value = String(settings.targetPx)
    /**
     * Сохраняем по 'change', а не по 'input': иначе при наборе «1920»
     * в хранилище последовательно улетели бы 1, 19, 192 и 1920, и каждое
     * из них сбросило бы кеш настроек во всех вкладках.
     */
    targetPx.addEventListener('change', () => {
      const value = Number(targetPx.value)
      // Поле ввода можно обойти вставкой, поэтому границы проверяются и здесь.
      const clamped = Math.min(8192, Math.max(64, Math.round(value) || DEFAULT_SETTINGS.targetPx))
      targetPx.value = String(clamped)
      void patchSettings({ targetPx: clamped })
        .then(() => flashSaved(saveStateFor(targetPx)))
        .catch((error: unknown) => log.error('Не удалось сохранить размер:', error))
    })
  }

  const toggles: [string, keyof Settings][] = [
    ['skip-if-large', 'skipIfLargeEnough'],
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
