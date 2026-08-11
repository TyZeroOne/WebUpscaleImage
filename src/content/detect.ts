/**
 * Поиск медиа-элементов на странице.
 *
 * На этапе 0 это только подсчёт — оверлеи и обработка появятся на этапе 1 и 2.
 * Но фильтрация уже здесь, потому что без неё цифры бессмысленны: на обычной
 * странице десятки <img> — это иконки, спейсеры и трекинг-пиксели, а не
 * контент, который имеет смысл улучшать.
 */

/**
 * Минимальная сторона изображения в CSS-пикселях, ниже которой мы его
 * игнорируем. 64 px выбрано как порог между «иконка/аватарка в списке»
 * и «картинка, на которую пользователь смотрит»: типовые размеры фавиконок
 * и UI-иконок — 16/24/32/48, следующий распространённый размер уже 64+.
 */
const MIN_SIDE_PX = 64

export interface MediaScanResult {
  images: HTMLImageElement[]
  videos: HTMLVideoElement[]
}

export function isEnhanceableImage(img: HTMLImageElement): boolean {
  // naturalWidth === 0 — картинка ещё не загрузилась или битая.
  if (img.naturalWidth === 0 || img.naturalHeight === 0) return false

  const rect = img.getBoundingClientRect()
  // Нулевой размер = display:none, спейсер или трекинг-пиксель.
  if (rect.width < MIN_SIDE_PX || rect.height < MIN_SIDE_PX) return false

  return true
}

export function scanMedia(root: ParentNode = document): MediaScanResult {
  return {
    images: Array.from(root.querySelectorAll('img')).filter(isEnhanceableImage),
    // Видео собираем уже сейчас, хотя обрабатывать не умеем: это точка
    // расширения под будущий этап, см. src/video/.
    videos: Array.from(root.querySelectorAll('video')),
  }
}
