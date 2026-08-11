import { createLogger } from '@/core/log'
import { sendToBackground } from '@/core/messaging'

/**
 * Получение пикселей картинки со страницы.
 *
 * Это самая коварная часть проекта, и вот почему.
 *
 * ЧТО ТАКОЕ TAINTED CANVAS
 *
 * Браузер разрешает нарисовать на canvas любую картинку, включая чужую
 * с другого домена. Но как только на canvas попала картинка с другого
 * источника, canvas помечается «испорченным» (tainted), и всякая попытка
 * ПРОЧИТАТЬ из него пиксели — getImageData, toBlob, convertToBlob —
 * выбрасывает SecurityError.
 *
 * Это не придирка, а защита от кражи данных. Без неё любой сайт мог бы
 * вставить <img src="https://банк.example/выписка.png">, нарисовать её на
 * canvas и прочитать содержимое — браузер-то отправит запрос с куками
 * пользователя и получит его личную страницу.
 *
 * ТРИ ПОПЫТКИ, ОТ ДЕШЁВОЙ К ДОРОГОЙ
 *
 * 1. Использовать уже загруженную картинку. Сети нет вообще. Работает для
 *    своего домена и для всего, что уже пришло с CORS-заголовками.
 * 2. Перезагрузить с crossOrigin="anonymous". Браузер отправит запрос без кук
 *    и проверит Access-Control-Allow-Origin в ответе. Работает на большинстве CDN.
 * 3. Попросить service worker. Его запросы CORS не ограничивает вовсе —
 *    это последний рубеж, добавленный на этапе 7. Требует host_permissions.
 */

const log = createLogger('image-source')

export type ImageSourceFailure =
  | 'not-loaded'
  | 'tainted'
  | 'decode-failed'
  | 'unsupported-format'
  | 'too-large'

export class ImageSourceError extends Error {
  constructor(
    readonly reason: ImageSourceFailure,
    message: string,
  ) {
    super(message)
    this.name = 'ImageSourceError'
  }
}

/**
 * Сколько ждать повторную загрузку картинки в CORS-режиме.
 *
 * Картинка уже показана на странице, то есть точно есть в кеше или доступна.
 * Повторный запрос обычно укладывается в доли секунды. 10 секунд — потолок
 * на случай медленной сети, после которого честнее показать ошибку, чем
 * держать пользователя в неведении.
 */
const CORS_RELOAD_TIMEOUT_MS = 10_000

/**
 * Потолок размера исходной картинки в пикселях.
 *
 * Проверяется ДО начала работы, чтобы отказать понятным сообщением, а не
 * нехваткой памяти где-то в середине фильтра. 40 Мп — это, например,
 * 8000×5000: заметно больше, чем даёт любая потребительская камера
 * в вебе, и уже за пределами потолка результата (24 Мп).
 */
const MAX_SOURCE_PIXELS = 40_000_000

/**
 * SVG — векторная графика.
 *
 * Увеличивать её бессмысленно: браузер и так рисует её без потерь в любом
 * размере. Растеризовать в двукратный PNG значит превратить масштабируемую
 * картинку в немасштабируемую — то есть ухудшить.
 *
 * Определяется по расширению и по data:-схеме. Способ неточный (сервер мог
 * отдать SVG по адресу без расширения), но дешёвый и покрывает практически
 * все случаи; ошибка в другую сторону безобидна — картинка просто обработается.
 */
export function isVectorImage(url: string): boolean {
  return /^data:image\/svg\+xml/i.test(url) || /\.svgz?($|[?#])/i.test(url)
}

/**
 * Проверка, читаются ли пиксели.
 *
 * Узнать «испорчен ли будет canvas» заранее нельзя — нет такого свойства
 * ни у картинки, ни у ImageBitmap. Единственный надёжный способ — попробовать
 * прочитать. Пробуем на холсте 1×1: стоимость близка к нулю, а ответ точный.
 */
function isReadable(bitmap: ImageBitmap): boolean {
  const canvas = new OffscreenCanvas(1, 1)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  ctx.drawImage(bitmap, 0, 0, 1, 1)
  try {
    ctx.getImageData(0, 0, 1, 1)
    return true
  } catch {
    return false
  }
}

function loadWithCors(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const probe = new Image()
    /**
     * crossOrigin = 'anonymous' меняет сам сетевой запрос: браузер отправит
     * его без кук и потребует от сервера заголовок Access-Control-Allow-Origin.
     * Нет заголовка — сработает onerror, картинка просто не загрузится.
     *
     * Значение 'use-credentials' здесь не годится: оно отправляет куки,
     * и тогда сервер обязан ответить конкретным origin вместо `*`,
     * что почти никто не делает.
     */
    probe.crossOrigin = 'anonymous'

    const timer = setTimeout(() => {
      probe.src = ''
      reject(new ImageSourceError('tainted', 'Истекло время повторной загрузки'))
    }, CORS_RELOAD_TIMEOUT_MS)

    probe.onload = () => {
      clearTimeout(timer)
      resolve(probe)
    }
    probe.onerror = () => {
      clearTimeout(timer)
      reject(new ImageSourceError('tainted', 'Сервер не разрешает чтение картинки'))
    }

    /**
     * src присваивается ПОСЛЕ обработчиков. Если картинка есть в кеше,
     * onload может сработать синхронно при присваивании — и обработчик,
     * назначенный после, её уже не увидит.
     */
    probe.src = url
  })
}

/**
 * Третья попытка: загрузка силами расширения.
 *
 * Возвращает null, если и это не помогло, — вызывающая сторона тогда
 * сообщит пользователю понятную причину.
 */
async function loadViaBackground(url: string): Promise<ImageBitmap | null> {
  const response = await sendToBackground('FETCH_IMAGE', { url })
  if (!response) {
    log.warn('Service worker не ответил на запрос загрузки')
    return null
  }
  if (!response.ok) {
    log.warn(`Расширение не смогло загрузить картинку: ${response.reason}`)
    return null
  }

  /**
   * data: URL никогда не портит canvas: данные пришли не из сети, а из
   * самой строки, и «чужого источника» у них нет. Поэтому bitmap,
   * созданный отсюда, гарантированно читается.
   */
  const blob = await (await fetch(response.dataUrl)).blob()
  log.debug(`Картинка получена через расширение: ${Math.round(response.bytes / 1024)} КБ`)
  return createImageBitmap(blob)
}

/**
 * Возвращает ImageBitmap, из которого гарантированно можно читать пиксели.
 */
export async function acquireReadableBitmap(image: HTMLImageElement): Promise<ImageBitmap> {
  if (!image.complete || image.naturalWidth === 0) {
    throw new ImageSourceError('not-loaded', 'Картинка ещё не загрузилась')
  }

  const url = image.currentSrc || image.src

  if (isVectorImage(url)) {
    throw new ImageSourceError('unsupported-format', 'Векторная картинка')
  }
  if (image.naturalWidth * image.naturalHeight > MAX_SOURCE_PIXELS) {
    throw new ImageSourceError('too-large', 'Картинка слишком большая')
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(image)
  } catch (error) {
    log.warn('createImageBitmap из элемента не удался:', error)
    throw new ImageSourceError('decode-failed', 'Не удалось декодировать картинку')
  }

  if (isReadable(bitmap)) return bitmap

  log.debug('Пиксели закрыты CORS, пробую перезагрузить с crossOrigin=anonymous')
  // Первый bitmap больше не нужен: он держит копию пикселей в памяти.
  bitmap.close()

  try {
    const corsImage = await loadWithCors(url)
    const corsBitmap = await createImageBitmap(corsImage)
    if (isReadable(corsBitmap)) return corsBitmap
    // Такое случается: сервер прислал заголовок, но не тот.
    corsBitmap.close()
  } catch (error) {
    log.debug('Повторная загрузка с CORS не удалась:', error)
  }

  log.debug('Пробую загрузить картинку силами расширения')
  const viaBackground = await loadViaBackground(url)
  if (viaBackground) return viaBackground

  throw new ImageSourceError('tainted', 'Не удалось получить доступ к пикселям картинки')
}
