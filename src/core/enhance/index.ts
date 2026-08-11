import { CanvasEnhancer, resolveTargetSize } from './canvas-enhancer'
import { resolvePlan } from './policy'
import type { ImageEnhancer, QualityLevel } from './types'

export * from './types'
export * from './policy'
export { resolveTargetSize }

/**
 * Выбор реализации улучшения.
 *
 * Единственная точка, где уровень качества превращается в конкретный
 * апскейлер. Весь остальной код просит «улучшатель», не зная, какой.
 */
export function createEnhancer(level: QualityLevel): ImageEnhancer {
  return new CanvasEnhancer(resolvePlan(level).lanczosRadius)
}

/** Минимальный коэффициент увеличения. Меньше 2 пользователь не заметит. */
const MIN_SCALE = 2

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
 * @param maxScale     потолок из правил уровня качества: на «быстро» он ниже,
 *                     потому что там нет смысла раздувать результат
 */
export function resolveScale(
  displayWidth: number,
  naturalWidth: number,
  pixelRatio: number,
  maxScale: number,
): number {
  if (naturalWidth <= 0) return Math.min(MIN_SCALE, maxScale)
  const needed = (displayWidth * pixelRatio) / naturalWidth
  return Math.min(maxScale, Math.max(MIN_SCALE, Math.ceil(needed * 2) / 2))
}
