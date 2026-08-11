import { createLogger } from '@/core/log'

/**
 * Настройки расширения.
 *
 * На этапе 0 здесь ровно один флаг — этого достаточно, чтобы проверить, что
 * chrome.storage работает и что options-страница действительно связана с
 * остальным расширением. Полноценный набор настроек (уровень качества,
 * автоматический режим, лимит параллелизма) появится на этапе 6.
 */

const log = createLogger('settings')

export interface Settings {
  /** Подробные логи в консоли. Нужен, когда пользователь присылает баг-репорт. */
  verboseLogging: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  verboseLogging: false,
}

/**
 * chrome.storage.sync, а не .local: настроек мало, они текстовые и их удобно
 * иметь одинаковыми на всех устройствах пользователя. Ограничения sync
 * (100 КБ всего, 8 КБ на ключ) нам не мешают. Кэши и результаты обработки
 * в sync класть нельзя — они пойдут в .local, когда появятся.
 */
const AREA = chrome.storage.sync

/**
 * Обобщённый параметр <Settings> обязателен: без него @types/chrome выводит
 * тип хранилища как индексируемый `{ [key: string]: unknown }`, а обычный
 * интерфейс в такой тип не присваивается (у интерфейсов нет неявной
 * индексной сигнатуры). Заодно get() возвращает сразу Settings, а не unknown.
 */
export async function getSettings(): Promise<Settings> {
  try {
    // Передача объекта по умолчанию — штатный способ chrome.storage вернуть
    // значения для ключей, которых в хранилище ещё нет.
    const stored = await AREA.get<Settings>(DEFAULT_SETTINGS)
    return { ...DEFAULT_SETTINGS, ...stored }
  } catch (error) {
    log.error('Не удалось прочитать настройки, беру значения по умолчанию:', error)
    return { ...DEFAULT_SETTINGS }
  }
}

export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  await AREA.set<Settings>(patch)
}

/** Подписка на изменения настроек — работает во всех контекстах расширения. */
export function onSettingsChanged(listener: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    if (!Object.keys(changes).some((key) => key in DEFAULT_SETTINGS)) return
    void getSettings().then(listener)
  })
}
