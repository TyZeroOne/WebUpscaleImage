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

/**
 * Минимальное уменьшение.
 *
 * Ниже десятой доли от оригинала результат перестаёт быть картинкой
 * и становится превью, а чаще означает, что пользователь ошибся в поле ввода.
 */
const MIN_DOWNSCALE = 0.1

export interface TargetPlan {
  /** Во сколько раз менять размер. Меньше единицы — уменьшение. */
  scale: number
  /** Обработка не нужна: картинка уже подходит. */
  skip: boolean
}

/**
 * Приведение длинной стороны к заданному числу пикселей.
 *
 * ПОЧЕМУ ДЛИННАЯ СТОРОНА, А НЕ ШИРИНА
 *
 * На странице соседствуют горизонтальные баннеры и вертикальные портреты.
 * Приведи их к одной ширине — вертикальные вырастут вдвое сильнее, чем
 * ожидалось, и займут несоразмерно много памяти. Длинная сторона даёт
 * предсказуемый потолок площади независимо от ориентации.
 *
 * ПОЧЕМУ ДОПУСКАЕТСЯ УМЕНЬШЕНИЕ
 *
 * «Привести к размеру» — не то же самое, что «увеличить». Пользователю может
 * понадобиться привести пёструю страницу к единому размеру, и картинки крупнее
 * цели должны при этом уменьшаться. Фильтр Ланцоша это умеет: при уменьшении
 * окно фильтра растягивается, иначе получился бы алиасинг (см. этап 2).
 *
 * @param skipIfLargeEnough не трогать то, что уже не меньше цели
 * @param maxScale          потолок увеличения из правил уровня качества
 */
export function resolveTargetScale(
  naturalWidth: number,
  naturalHeight: number,
  targetPx: number,
  skipIfLargeEnough: boolean,
  maxScale: number,
): TargetPlan {
  const longest = Math.max(naturalWidth, naturalHeight)
  if (longest <= 0 || targetPx <= 0) return { scale: 1, skip: true }

  if (skipIfLargeEnough && longest >= targetPx) return { scale: 1, skip: true }

  const wanted = targetPx / longest
  const scale = Math.min(maxScale, Math.max(MIN_DOWNSCALE, wanted))

  /**
   * Изменение меньше чем на процент не стоит перекодирования: результат
   * визуально тот же, а картинка на странице подменится на файл, который
   * ещё и может весить больше оригинала.
   */
  if (Math.abs(scale - 1) < 0.01) return { scale: 1, skip: true }

  return { scale, skip: false }
}
