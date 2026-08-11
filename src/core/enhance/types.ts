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

/** Чем именно посчитали результат — нужно и для логов, и для UI. */
export type EnhanceBackend = 'canvas-bilinear' | 'canvas-lanczos' | 'ml-webgpu' | 'ml-wasm'

export interface EnhanceOptions {
  level: QualityLevel
  /** Во сколько раз увеличить сторону. 1 — только шумоподавление/резкость. */
  scale: number
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
