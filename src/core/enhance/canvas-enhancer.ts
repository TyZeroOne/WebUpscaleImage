import type {
  EnhanceBackend,
  EnhanceInput,
  EnhanceOptions,
  EnhanceResult,
  ImageEnhancer,
} from './types'
import { resampleLanczos } from './lanczos'

/**
 * Реализация ImageEnhancer поверх Canvas 2D.
 *
 * Модуль работает ТОЛЬКО с OffscreenCanvas, хотя на этапе 2 выполняется
 * в content script, где доступен и обычный <canvas>. Это сделано намеренно:
 * OffscreenCanvas существует и в Web Worker, а HTMLCanvasElement — нет.
 * За счёт этого перенос вычислений в Worker на этапе 4 не потребует
 * переписывать сам апскейлер.
 */

/**
 * Потолок размера результата, в пикселях.
 *
 * Ограничение не эстетическое, а по памяти. На каждый выходной пиксель нужно:
 * 4 байта ImageData + 16 байт промежуточного Float32-буфера (в нём хранится
 * картинка уже растянутая по горизонтали) + столько же на итоговый Blob PNG
 * в худшем случае. 24 Мп — это порядка 600 МБ пиковой памяти вкладки.
 * Выше начинается риск, что вкладку убьёт сам браузер.
 */
const MAX_OUTPUT_PIXELS = 24_000_000

/** Целевой размер с учётом потолка. Коэффициент при необходимости снижается. */
export function resolveTargetSize(
  srcWidth: number,
  srcHeight: number,
  scale: number,
): { width: number; height: number; appliedScale: number } {
  const srcPixels = srcWidth * srcHeight
  const maxScale = Math.sqrt(MAX_OUTPUT_PIXELS / srcPixels)
  const appliedScale = Math.min(scale, maxScale)
  return {
    width: Math.max(1, Math.round(srcWidth * appliedScale)),
    height: Math.max(1, Math.round(srcHeight * appliedScale)),
    appliedScale,
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Обработка отменена', 'AbortError')
}

function context2d(canvas: OffscreenCanvas, willReadFrequently = false): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently })
  if (!ctx) throw new Error('Не удалось получить контекст 2d')
  return ctx
}

export class CanvasEnhancer implements ImageEnhancer {
  readonly backend: EnhanceBackend

  /**
   * @param radius радиус окна Ланцоша, либо null — масштабировать
   *               средствами браузера. Значение приходит из правил уровня
   *               качества (core/enhance/policy.ts), а не выводится здесь:
   *               апскейлер не должен знать про уровни.
   */
  constructor(private readonly radius: number | null) {
    this.backend = radius === null ? 'canvas-bilinear' : 'canvas-lanczos'
  }

  /** Canvas 2D есть везде, где вообще может исполняться расширение. */
  async isAvailable(): Promise<boolean> {
    return typeof OffscreenCanvas !== 'undefined'
  }

  async enhance(
    input: EnhanceInput,
    options: EnhanceOptions,
    signal?: AbortSignal,
  ): Promise<EnhanceResult> {
    const startedAt = performance.now()
    const { bitmap } = input
    const target = resolveTargetSize(bitmap.width, bitmap.height, options.scale)

    assertNotAborted(signal)

    const canvas =
      this.radius === null
        ? this.scaleNative(bitmap, target.width, target.height)
        : this.scaleLanczos(bitmap, target.width, target.height, this.radius, signal)

    assertNotAborted(signal)

    /**
     * PNG, а не JPEG/WebP.
     *
     * Инструмент называется «улучшение качества»; перекодировать результат
     * с потерями сразу после того, как мы его аккуратно посчитали, —
     * противоречие. Цена — размер файла: PNG фотографии 4К легко весит
     * десятки мегабайт.
     *
     * Выбор формата — кандидат в настройки этапа 6, а не решение,
     * которое нужно принимать за пользователя молча.
     */
    const blob = await canvas.convertToBlob({ type: 'image/png' })

    return {
      blob,
      width: target.width,
      height: target.height,
      durationMs: Math.round(performance.now() - startedAt),
      backend: this.backend,
    }
  }

  /**
   * Быстрый путь: масштабирование средствами браузера.
   *
   * drawImage со сглаживанием реализован в нативном коде и обычно использует
   * GPU, поэтому работает в десятки раз быстрее нашего JS-фильтра и не вешает
   * страницу. Качество ниже: Chrome применяет билинейную фильтрацию по
   * уменьшенным копиям, результат мягкий.
   */
  private scaleNative(bitmap: ImageBitmap, width: number, height: number): OffscreenCanvas {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = context2d(canvas)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas
  }

  /** Качественный путь: читаем пиксели и считаем фильтр сами. */
  private scaleLanczos(
    bitmap: ImageBitmap,
    width: number,
    height: number,
    radius: number,
    signal: AbortSignal | undefined,
  ): OffscreenCanvas {
    const source = new OffscreenCanvas(bitmap.width, bitmap.height)
    // willReadFrequently: подсказка браузеру держать буфер в оперативной
    // памяти, а не в видеопамяти. Без неё getImageData вызывает дорогое
    // копирование с GPU.
    const sourceCtx = context2d(source, true)
    sourceCtx.drawImage(bitmap, 0, 0)

    /**
     * Здесь бросается SecurityError, если картинка «испортила» canvas
     * (tainted canvas). Ловить его тут не нужно: вызывающая сторона
     * (src/content/image-source.ts) обязана передать сюда уже пригодный
     * к чтению ImageBitmap.
     */
    const sourceData = sourceCtx.getImageData(0, 0, bitmap.width, bitmap.height)
    assertNotAborted(signal)

    const resampled = resampleLanczos(sourceData, width, height, radius)

    const canvas = new OffscreenCanvas(width, height)
    context2d(canvas).putImageData(resampled, 0, 0)
    return canvas
  }
}
