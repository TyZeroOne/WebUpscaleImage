import { createLogger } from '@/core/log'

/**
 * Что делать с готовым результатом: подменить картинку на странице
 * или отдать пользователю файлом.
 */

const log = createLogger('apply')

interface OriginalState {
  src: string | null
  srcset: string | null
  sizes: string | null
  /** <source> внутри <picture>: они перебивают src у <img>. */
  pictureSources: { element: HTMLSourceElement; srcset: string | null }[]
  objectUrl: string
}

/**
 * WeakMap, а не Map: ключ — DOM-элемент. Обычный Map держал бы ссылку
 * на удалённую со страницы картинку и не давал бы собрать её сборщику
 * мусора — на бесконечной ленте это утечка, растущая без предела.
 */
const originals = new WeakMap<HTMLImageElement, OriginalState>()

/**
 * Подменяет картинку на странице результатом обработки.
 *
 * Недостаточно просто присвоить src. Современная разметка задаёт картинку
 * тремя способами сразу, и любой из них перебьёт наше присваивание:
 *
 *   <picture>
 *     <source srcset="photo.avif" type="image/avif">   ← приоритет выше src
 *     <img src="photo.jpg" srcset="photo@2x.jpg 2x">   ← srcset тоже выше src
 *   </picture>
 *
 * Браузер выбирает источник заново при изменении размера окна или смене
 * экрана. Если оставить srcset, наша картинка через секунду молча
 * вернётся к оригиналу — и выглядеть это будет как «расширение не работает».
 */
export function replaceOnPage(image: HTMLImageElement, blob: Blob): void {
  // Повторное улучшение той же картинки: старый объектный URL освобождаем,
  // но исходное состояние сохраняем первое — чтобы «вернуть оригинал»
  // возвращало действительно оригинал, а не предыдущий результат.
  const previous = originals.get(image)
  if (previous) URL.revokeObjectURL(previous.objectUrl)

  const objectUrl = URL.createObjectURL(blob)

  const pictureSources: OriginalState['pictureSources'] = []
  const parent = image.parentElement
  if (parent instanceof HTMLPictureElement) {
    for (const source of parent.querySelectorAll('source')) {
      pictureSources.push({ element: source, srcset: source.getAttribute('srcset') })
      source.removeAttribute('srcset')
    }
  }

  if (!previous) {
    originals.set(image, {
      src: image.getAttribute('src'),
      srcset: image.getAttribute('srcset'),
      sizes: image.getAttribute('sizes'),
      pictureSources,
      objectUrl,
    })
  } else {
    originals.set(image, { ...previous, objectUrl })
  }

  image.removeAttribute('srcset')
  image.removeAttribute('sizes')
  image.src = objectUrl
}

export function hasOriginal(image: HTMLImageElement): boolean {
  return originals.has(image)
}

/** Возвращает страницу в исходное состояние и освобождает память. */
export function restoreOriginal(image: HTMLImageElement): boolean {
  const state = originals.get(image)
  if (!state) return false

  for (const { element, srcset } of state.pictureSources) {
    if (srcset !== null) element.setAttribute('srcset', srcset)
  }
  if (state.srcset !== null) image.setAttribute('srcset', state.srcset)
  if (state.sizes !== null) image.setAttribute('sizes', state.sizes)
  if (state.src !== null) image.setAttribute('src', state.src)

  /**
   * Объектный URL держит Blob в памяти, пока его не освободят явно.
   * Апскейл 4К весит десятки мегабайт; забыть revokeObjectURL здесь —
   * значит подарить вкладке утечку размером с картинку на каждое действие.
   */
  URL.revokeObjectURL(state.objectUrl)
  originals.delete(image)
  log.debug('Оригинал восстановлен')
  return true
}

/** Имя файла для скачивания: из адреса исходной картинки. */
export function buildFileName(sourceUrl: string, width: number, height: number): string {
  let base = 'image'
  try {
    const path = new URL(sourceUrl, location.href).pathname
    const last = path.split('/').filter(Boolean).pop()
    if (last) base = last.replace(/\.[^.]+$/, '')
  } catch {
    // data: и blob: URL сюда попадают штатно — оставляем имя по умолчанию.
  }
  // Символы, недопустимые в именах файлов Windows и неудобные в остальных.
  base = base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'image'
  return `${base}-${width}x${height}.png`
}

/**
 * Скачивание результата.
 *
 * Используется обычная ссылка с атрибутом download, а не chrome.downloads:
 * API расширения потребовало бы разрешения `downloads`, которое показывает
 * пользователю отдельное предупреждение при установке. Ради сохранения файла,
 * которое браузер умеет сам, это неоправданно.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  // Ссылку не обязательно вставлять в документ — click() работает и так,
  // а вставка изменила бы DOM страницы, чего мы избегаем.
  link.click()
  /**
   * Освобождать URL сразу после click() нельзя: скачивание к этому моменту
   * ещё не началось. Задержка даёт браузеру время подхватить данные.
   * Минуту держать тоже незачем — секунды хватает с запасом.
   */
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
