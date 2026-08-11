import { createLogger } from '@/core/log'
import type { RequestOf, ResponseOf } from '@/core/messaging'

/**
 * Загрузка картинки силами расширения.
 *
 * ЗАЧЕМ ЭТО НУЖНО
 *
 * Большинство картинок в интернете лежит на CDN, то есть на чужом для страницы
 * домене. Прочитать их пиксели со страницы нельзя: canvas помечается
 * «испорченным» (см. этап 2). Обходной путь с crossOrigin='anonymous' работает
 * только когда сервер сам прислал заголовок Access-Control-Allow-Origin —
 * то есть далеко не всегда.
 *
 * Запросы service worker'а расширения CORS не ограничивает вообще: браузер
 * доверяет расширению, которому пользователь выдал host_permissions. Поэтому
 * последний рубеж выглядит так: страница не смогла — попроси расширение.
 *
 * ПОЧЕМУ ОТВЕТ ИДЁТ СТРОКОЙ
 *
 * chrome.runtime.sendMessage сериализует сообщение в JSON. Ни Blob,
 * ни ArrayBuffer через него не проходят — они превратятся в пустой объект.
 * Единственный способ передать двоичные данные — закодировать их в текст,
 * и base64 для этого стандартный выбор. Цена — рост объёма на треть
 * и время на кодирование.
 */

const log = createLogger('image-fetch')

/**
 * Потолок размера картинки, которую имеет смысл тащить через канал сообщений.
 *
 * 12 МБ исходных данных превращаются в строку base64 примерно на 16 МБ,
 * которую ещё нужно сериализовать в JSON и разобрать на другой стороне.
 * Это уже десятки миллисекунд и десятки мегабайт временной памяти.
 *
 * Картинки крупнее почти наверняка и так не пройдут по потолку размера
 * результата (24 Мп), так что ограничение не отсекает ничего рабочего.
 */
const MAX_BYTES = 12 * 1024 * 1024

/**
 * Кодирование в base64 порциями.
 *
 * Напрашивающееся `String.fromCharCode(...bytes)` на картинке в мегабайт
 * падает с «Maximum call stack size exceeded»: массив разворачивается
 * в аргументы вызова, а их число ограничено. Порция в 32 КБ заведомо
 * влезает в любой движок.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

export async function fetchImageAsDataUrl(
  payload: RequestOf<'FETCH_IMAGE'>,
): Promise<ResponseOf<'FETCH_IMAGE'>> {
  let parsed: URL
  try {
    parsed = new URL(payload.url)
  } catch {
    return { ok: false, reason: 'unsupported-scheme' }
  }

  /**
   * Схемы, которые service worker загрузить не может в принципе:
   *   blob: — объектный URL существует только в контексте создавшей его
   *           страницы, для расширения это несуществующий адрес;
   *   data: — уже содержит данные, обходной путь для них не нужен
   *           (и они никогда не портят canvas).
   */
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-scheme' }
  }

  try {
    /**
     * credentials: 'omit' — куки пользователя не отправляются.
     *
     * Это осознанное ограничение возможностей ради безопасности. С куками
     * расширение могло бы скачать личную страницу пользователя по любому
     * адресу, который назовёт сайт, — ровно та атака, от которой защищает
     * CORS. Цена: картинки, требующие авторизации (закрытые галереи),
     * этим путём не загрузятся.
     */
    const response = await fetch(payload.url, { credentials: 'omit', cache: 'force-cache' })
    if (!response.ok) {
      log.warn(`Сервер ответил ${response.status} на ${payload.url}`)
      return { ok: false, reason: 'network' }
    }

    const type = response.headers.get('content-type') ?? ''
    if (type && !type.startsWith('image/')) {
      return { ok: false, reason: 'not-image' }
    }

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_BYTES) {
      return { ok: false, reason: 'too-large' }
    }

    const mime = type.split(';')[0] || 'image/png'
    const dataUrl = `data:${mime};base64,${toBase64(new Uint8Array(buffer))}`
    return { ok: true, dataUrl, bytes: buffer.byteLength }
  } catch (error) {
    log.warn('Загрузка не удалась:', error)
    return { ok: false, reason: 'network' }
  }
}
