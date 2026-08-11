import { CanvasEnhancer, resolveTargetSize } from './canvas-enhancer'
import type { ImageEnhancer, QualityLevel } from './types'

export * from './types'
export { resolveTargetSize }

/**
 * Выбор реализации улучшения.
 *
 * На этапе 2 выбор тривиален — есть только Canvas. Функция всё равно нужна:
 * на этапе 5 сюда добавится ML-реализация, и точка выбора уже будет
 * единственной. Весь остальной код просит «улучшатель», не зная, какой.
 */
export function createEnhancer(level: QualityLevel): ImageEnhancer {
  return new CanvasEnhancer(level)
}

/**
 * Уровень качества по умолчанию.
 *
 * `balanced` (Ланцош с радиусом 2), а не `quality`: по замерам радиус 3
 * стоит примерно на 30% дороже (253 против 325 мс на 1920×1080 → 3840×2160),
 * а разница в резкости различима только при внимательном сравнении
 * фрагментов. Пока вычисления идут в главном потоке (до этапа 4), эти 30%
 * — прямое время, на которое замирает страница пользователя.
 *
 * Выбор пользователем появится на этапе 6.
 */
export const DEFAULT_QUALITY_LEVEL: QualityLevel = 'balanced'

/** Минимальный коэффициент увеличения. Меньше 2 пользователь не заметит. */
const MIN_SCALE = 2

/** Больше 4 крат классическая интерполяция уже не даёт полезной детализации. */
const MAX_SCALE = 4

/**
 * Во сколько раз увеличивать картинку.
 *
 * Наивный ответ — «всегда в два раза» — во многих случаях не даёт видимого
 * эффекта. Если картинка показана в её собственном размере на обычном
 * экране, увеличенную копию браузер тут же ужмёт обратно, и пользователь
 * не увидит ничего.
 *
 * Видимый выигрыш есть там, где картинке НЕ ХВАТАЕТ пикселей:
 *  - её растянули стилями (displayWidth больше naturalWidth) — она мыльная;
 *  - экран HiDPI (devicePixelRatio 2 и выше) — на каждый CSS-пиксель нужно
 *    вдвое больше настоящих.
 *
 * Поэтому коэффициент считается от реальной нехватки, а не берётся с потолка.
 *
 * @param displayWidth ширина, с которой картинка показана на странице, в CSS-пикселях
 * @param naturalWidth собственная ширина файла
 * @param pixelRatio   devicePixelRatio экрана
 */
export function resolveScale(
  displayWidth: number,
  naturalWidth: number,
  pixelRatio: number,
): number {
  if (naturalWidth <= 0) return MIN_SCALE
  const needed = (displayWidth * pixelRatio) / naturalWidth
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.ceil(needed * 2) / 2))
}
