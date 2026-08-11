/**
 * Определение возможностей устройства.
 *
 * На этапе 0 — только синхронная проверка наличия API. Этого хватает, чтобы
 * popup показал, чего ждать от машины, и чтобы убедиться, что модуль вообще
 * подключён к сборке.
 *
 * На этапе 5 здесь появится реальная проба: запрос GPUAdapter, проверка
 * поддержки WASM SIMD и выбор уровня качества под железо. Синхронной проверки
 * `'gpu' in navigator` для этого недостаточно — наличие объекта не гарантирует,
 * что requestAdapter() вернёт адаптер (драйвер может быть в чёрном списке).
 */

export interface DeviceCapabilities {
  /** navigator.gpu присутствует. НЕ означает, что адаптер реально доступен. */
  webgpuApiPresent: boolean
  /** OffscreenCanvas — обязателен, чтобы рисовать вне main thread. */
  offscreenCanvas: boolean
  /** createImageBitmap — способ декодировать картинку без DOM. */
  imageBitmap: boolean
  /** Логических ядер. Отсюда возьмётся лимит параллелизма очереди на этапе 3. */
  logicalCores: number
  /** Приблизительный объём ОЗУ в ГБ. Chrome округляет и режет сверху до 8. */
  memoryGb: number | null
}

export function detectCapabilities(): DeviceCapabilities {
  return {
    webgpuApiPresent: typeof navigator !== 'undefined' && 'gpu' in navigator,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    imageBitmap: typeof createImageBitmap === 'function',
    logicalCores: navigator.hardwareConcurrency || 1,
    memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
  }
}
