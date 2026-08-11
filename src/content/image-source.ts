import { createLogger } from '@/core/log'

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
 * Для нас это значит: улучшить картинку мало, к её пикселям надо ещё
 * получить доступ. И большинство картинок в интернете — с CDN, то есть
 * с чужого домена.
 *
 * ЧТО С ЭТИМ МОЖНО СДЕЛАТЬ
 *
 * 1. Загрузить картинку заново с атрибутом crossOrigin="anonymous".
 *    Тогда браузер отправит запрос БЕЗ кук и проверит заголовок
 *    Access-Control-Allow-Origin в ответе. Если сервер его прислал —
 *    canvas остаётся чистым. Большинство CDN присылают (`*`), поэтому
 *    способ покрывает изрядную долю случаев. Это и делает данный модуль.
 *
 * 2. Скачать картинку из service worker'а с разрешением host_permissions.
 *    Запросы расширения из фонового контекста не подчиняются CORS вовсе,
 *    поэтому способ работает всегда. Цена — пугающее разрешение «доступ
 *    ко всем сайтам» при установке. Это решение этапа 7.
 */

const log = createLogger('image-source')

export type ImageSourceFailure =
  | 'not-loaded'
  | 'tainted'
  | 'decode-failed'

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
 * Возвращает ImageBitmap, из которого гарантированно можно читать пиксели.
 *
 * Порядок попыток выстроен от дешёвого к дорогому: сначала используем уже
 * загруженную картинку (сети нет вообще), и только если её пиксели закрыты —
 * идём в сеть за CORS-копией.
 */
export async function acquireReadableBitmap(image: HTMLImageElement): Promise<ImageBitmap> {
  if (!image.complete || image.naturalWidth === 0) {
    throw new ImageSourceError('not-loaded', 'Картинка ещё не загрузилась')
  }

  const url = image.currentSrc || image.src

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

  const corsImage = await loadWithCors(url)
  const corsBitmap = await createImageBitmap(corsImage)

  if (!isReadable(corsBitmap)) {
    // Такое случается: сервер прислал заголовок, но не тот. Проверка
    // остаётся, потому что альтернатива — SecurityError глубоко внутри
    // апскейлера, где непонятно, что произошло.
    corsBitmap.close()
    throw new ImageSourceError('tainted', 'Сервер не разрешает чтение картинки')
  }

  return corsBitmap
}
