import type { QualityLevel } from '@/core/enhance/types'
import { createLogger } from '@/core/log'

/**
 * Настройки расширения.
 *
 * До этапа 6 здесь был один флаг — он существовал ради проверки того, что
 * связка «страница настроек -> storage -> все контексты» вообще работает.
 * Теперь настройки начали влиять на поведение.
 */

const log = createLogger('settings')

/** Что выбрал пользователь. 'auto' — пусть решает расширение по железу. */
export type QualityPreference = QualityLevel | 'auto'

/**
 * Какая нейросеть используется.
 *
 * Обе — одна архитектура (RDN) и один диапазон входа, различаются размером
 * сети: у slim два плотных блока с ростом 4, у medium — десять с ростом 64.
 * Отсюда и разница в весах, и разница во времени.
 */
export type ModelChoice = 'slim' | 'medium'

/**
 * Как выбирается размер результата.
 *
 * 'auto'         — как раньше: коэффициент считается от того, насколько
 *                  картинке не хватает пикселей на экране.
 * 'longest-side' — привести длинную сторону к заданному числу. Может как
 *                  увеличить, так и уменьшить.
 */
export type TargetMode = 'auto' | 'longest-side'

export interface Settings {
  /** Подробные логи в консоли. Нужен, когда пользователь присылает баг-репорт. */
  verboseLogging: boolean
  /** Уровень качества обработки. */
  quality: QualityPreference
  /** Подменять картинку прямо на странице или только предлагать скачать. */
  replaceOnPage: boolean
  /** Какую модель использовать, когда работает нейросеть. */
  model: ModelChoice
  /** Как определять размер результата. */
  targetMode: TargetMode
  /** Желаемая длинная сторона в пикселях. Имеет смысл только при 'longest-side'. */
  targetPx: number
  /** Не трогать картинки, которые уже не меньше цели. */
  skipIfLargeEnough: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  verboseLogging: false,
  quality: 'auto',
  replaceOnPage: true,
  model: 'slim',
  targetMode: 'auto',
  /**
   * 1920 — ширина распространённого монитора. Значение видно и правится
   * пользователем; оно лишь стартовая точка, а не рекомендация.
   */
  targetPx: 1920,
  skipIfLargeEnough: true,
}

/**
 * chrome.storage.sync, а не .local: настроек мало, они текстовые и их удобно
 * иметь одинаковыми на всех устройствах пользователя. Ограничения sync
 * (100 КБ всего, 8 КБ на ключ) нам не мешают. Кэши и результаты обработки
 * в sync класть нельзя — они пойдут в .local, когда появятся.
 */
const AREA = chrome.storage.sync

/**
 * Кеш прочитанных настроек.
 *
 * Без него режим «вся страница» делал бы по обращению к хранилищу на каждую
 * картинку — полсотни лишних асинхронных вызовов за прогон. Кеш сбрасывается
 * по событию изменения, поэтому разъехаться с хранилищем не может.
 */
let cache: Settings | null = null

/**
 * Обобщённый параметр <Settings> обязателен: без него @types/chrome выводит
 * тип хранилища как индексируемый `{ [key: string]: unknown }`, а обычный
 * интерфейс в такой тип не присваивается (у интерфейсов нет неявной
 * индексной сигнатуры). Заодно get() возвращает сразу Settings, а не unknown.
 */
export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    // Передача объекта по умолчанию — штатный способ chrome.storage вернуть
    // значения для ключей, которых в хранилище ещё нет.
    const stored = await AREA.get<Settings>(DEFAULT_SETTINGS)
    cache = { ...DEFAULT_SETTINGS, ...stored }
  } catch (error) {
    log.error('Не удалось прочитать настройки, беру значения по умолчанию:', error)
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  await AREA.set<Settings>(patch)
}

/**
 * Сброс кеша при любом изменении настроек.
 *
 * Слушатель вешается на уровне модуля, а не внутри функции: изменение может
 * прийти из другого контекста расширения (страница настроек — это отдельный
 * документ), и узнать о нём надо независимо от того, спрашивал ли кто-то
 * настройки в этот момент.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return
  if (!Object.keys(changes).some((key) => key in DEFAULT_SETTINGS)) return
  cache = null
})

/** Подписка на изменения настроек — работает во всех контекстах расширения. */
export function onSettingsChanged(listener: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    if (!Object.keys(changes).some((key) => key in DEFAULT_SETTINGS)) return
    void getSettings().then(listener)
  })
}
