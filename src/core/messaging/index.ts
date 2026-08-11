import { createLogger } from '@/core/log'
import {
  MESSAGE_SOURCE,
  type MessageEnvelope,
  type MessageHandlers,
  type MessageKind,
  type RequestOf,
  type ResponseOf,
} from './types'

export * from './types'

const log = createLogger('messaging')

/** Отсекаем чужие сообщения: страница и другие расширения тоже могут писать в этот канал. */
function isOwnEnvelope(value: unknown): value is MessageEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { source?: unknown }).source === MESSAGE_SOURCE &&
    typeof (value as { kind?: unknown }).kind === 'string'
  )
}

/**
 * Отправка сообщения в service worker (из content script, popup или options).
 *
 * Возвращает null, если получателя нет. Это НОРМАЛЬНАЯ ситуация в MV3:
 * service worker выгружается после ~30 секунд простоя, а во время
 * перезагрузки расширения content script на странице ещё жив, но его канал
 * связи уже оборван («Extension context invalidated»). Бросать исключение
 * в таком случае — значит ронять логику страницы на ровном месте.
 */
export async function sendToBackground<K extends MessageKind>(
  kind: K,
  payload: RequestOf<K>,
): Promise<ResponseOf<K> | null> {
  const envelope: MessageEnvelope<K> = { source: MESSAGE_SOURCE, kind, payload }
  try {
    const response = (await chrome.runtime.sendMessage(envelope)) as ResponseOf<K> | undefined
    return response ?? null
  } catch (error) {
    log.warn(`Сообщение ${kind} не доставлено:`, error)
    return null
  }
}

/**
 * Отправка сообщения В content script конкретной вкладки.
 *
 * Это ДРУГОЙ канал, не тот, что у sendToBackground:
 *   chrome.runtime.sendMessage — «всем контекстам расширения» (service worker,
 *                                popup, options). Content script его НЕ получит.
 *   chrome.tabs.sendMessage    — «в content script указанной вкладки».
 *
 * Путаница между ними — типовая причина сообщений, которые «уходят в никуда»:
 * отправитель не видит ошибки, получатель ничего не получает.
 *
 * @param frameId номер фрейма. По умолчанию 0 — главный фрейм страницы;
 *                мы не внедряемся в iframe (all_frames: false в манифесте).
 */
export async function sendToTab<K extends MessageKind>(
  tabId: number,
  kind: K,
  payload: RequestOf<K>,
  frameId = 0,
): Promise<ResponseOf<K> | null> {
  const envelope: MessageEnvelope<K> = { source: MESSAGE_SOURCE, kind, payload }
  try {
    const response = (await chrome.tabs.sendMessage(tabId, envelope, { frameId })) as
      | ResponseOf<K>
      | undefined
    return response ?? null
  } catch (error) {
    // Штатные случаи: вкладку закрыли; страница служебная (chrome://,
    // Chrome Web Store), куда content script не внедряется вовсе;
    // страница ещё не догрузилась.
    log.warn(`Сообщение ${kind} не доставлено во вкладку ${tabId}:`, error)
    return null
  }
}

/**
 * Регистрация обработчиков входящих сообщений.
 *
 * Ключевой момент — `return true` в слушателе. Он говорит Chrome:
 * «ответ будет позже, не закрывай канал». Без него любой асинхронный
 * обработчик молча теряет ответ, а отправитель получает undefined.
 */
export function registerMessageHandlers(handlers: MessageHandlers): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isOwnEnvelope(message)) return false

    const handler = handlers[message.kind] as
      | ((payload: unknown, sender: chrome.runtime.MessageSender) => unknown)
      | undefined

    if (!handler) {
      log.warn(`Нет обработчика для сообщения ${message.kind}`)
      return false
    }

    Promise.resolve(handler(message.payload, sender))
      .then(sendResponse)
      .catch((error: unknown) => {
        // TODO (этап 7): передавать ошибку отправителю единым конвертом,
        // чтобы UI мог показать пользователю причину, а не «ничего не произошло».
        log.error(`Обработчик ${message.kind} упал:`, error)
        sendResponse(undefined)
      })

    return true
  })
}
