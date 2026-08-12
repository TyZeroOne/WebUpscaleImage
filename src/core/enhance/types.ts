/**
 * Контракт улучшения изображений.
 *
 * На этапе 0 это только интерфейсы. Смысл в том, чтобы зафиксировать границу
 * до появления реализаций: и классический апскейл (этап 2), и ML-апскейл
 * (этап 5) обязаны уложиться в один и тот же интерфейс ImageEnhancer.
 * Тогда выбор реализации становится вопросом одной строчки, а вызывающий код
 * (content script, очередь на этапе 3) не переписывается вообще.
 */

/** Уровень качества, который выбирает пользователь. */
export type QualityLevel = 'fast' | 'balanced' | 'quality'

/**
 * Что именно делаем с картинкой.
 *
 * 'upscale' — увеличить: размер результата больше исходного.
 * 'refine'  — улучшить качество, оставив размер прежним.
 *
 * Это не одно и то же действие с разным коэффициентом. При коэффициенте 1
 * ни модель, ни фильтр не дали бы ничего: модель увеличивает по своей
 * архитектуре, а интерполяция в тот же размер — тождественное преобразование.
 * Поэтому у 'refine' своя последовательность шагов, см. runRefine.
 */
export type EnhanceOperation = 'upscale' | 'refine'

/**
 * Почему запрошенная работа не изменила бы картинку.
 *
 * 'already-big-enough' — картинка уже не меньше целевого размера, а галочка
 *                        велит такие не трогать.
 * 'refine-no-op'       — улучшать нечем: выбранная модель не синтезирует
 *                        детали (или неприменима), а резкость выключена.
 *                        Улучшение качества складывается ровно из этих двух
 *                        вкладов, и без обоих операция вернула бы тот же
 *                        файл — только пересжатый и, возможно, более тяжёлый.
 */
export type NothingToDoReason = 'already-big-enough' | 'refine-no-op'

/**
 * Работы нет — и это не ошибка.
 *
 * Класс живёт здесь, а не в content-слое, потому что причину обнаруживают
 * в двух разных местах: планировщик — до получения пикселей, вычислитель —
 * уже после того, как выяснилось, что модель к этой картинке неприменима.
 */
export class NothingToDoError extends Error {
  constructor(readonly reason: NothingToDoReason) {
    super(
      reason === 'refine-no-op'
        ? 'Улучшать нечем: ни модели, ни резкости'
        : 'Картинка уже нужного размера',
    )
    this.name = 'NothingToDoError'
  }
}

/** Чем именно посчитали результат — нужно и для логов, и для UI. */
export type EnhanceBackend = 'canvas-bilinear' | 'canvas-lanczos' | 'ml-webgpu' | 'ml-wasm'

export interface EnhanceOptions {
  level: QualityLevel
  /** Во сколько раз увеличить сторону. 1 — только шумоподавление/резкость. */
  scale: number
  /**
   * Сила нерезкого маскирования в процентах, 0 — выключено.
   *
   * Применяется последним, уже к увеличенному изображению: усиливать края
   * до масштабирования бессмысленно — интерполяция их снова сгладит.
   */
  sharpen: number
}

export interface EnhanceInput {
  /**
   * ImageBitmap, а не HTMLImageElement: bitmap — transferable-объект,
   * его можно передать в Worker без копирования пикселей, и он не требует DOM.
   */
  bitmap: ImageBitmap
  /** Исходный URL — только для логов и имени файла при скачивании. */
  sourceUrl: string
}

export interface EnhanceResult {
  blob: Blob
  width: number
  height: number
  durationMs: number
  backend: EnhanceBackend
}

export interface ImageEnhancer {
  readonly backend: EnhanceBackend

  /**
   * Доступна ли реализация на этом устройстве. Асинхронно, потому что
   * проверка WebGPU требует await navigator.gpu.requestAdapter().
   */
  isAvailable(): Promise<boolean>

  /**
   * @param signal отмена: пользователь может закрыть вкладку или нажать
   *               «отмена» в очереди на этапе 3, и работа должна прекратиться.
   */
  enhance(
    input: EnhanceInput,
    options: EnhanceOptions,
    signal?: AbortSignal,
  ): Promise<EnhanceResult>
}
