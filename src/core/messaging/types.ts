/**
 * Контракт сообщений между слоями расширения.
 *
 * chrome.runtime.sendMessage принимает `any` и возвращает `any` — это главный
 * источник тихих поломок в расширениях: отправитель меняет форму сообщения,
 * получатель об этом не узнаёт до рантайма.
 *
 * Поэтому все сообщения описаны здесь одной картой «тип -> запрос/ответ»,
 * а отправка и приём идут только через типизированные обёртки из ./index.ts.
 */

/** Метка «своё» сообщение. Страница тоже может слать сообщения — их надо отсекать. */
export const MESSAGE_SOURCE = 'image-enhancer'

/**
 * Единственное место, куда добавляются новые типы сообщений.
 * Каждый следующий этап дописывает сюда свои записи.
 */
export interface MessageContracts {
  /** Проверка живости service worker'а. Используется popup'ом и в тестах. */
  PING: {
    request: { sentAt: number }
    response: { pong: true; roundTripStartedAt: number; version: string }
  }

  /** Content script сообщает, что нашёл на странице. Пока только для логов. */
  PAGE_SCAN: {
    request: { url: string; images: number; videos: number }
    response: { received: true }
  }
}

export type MessageKind = keyof MessageContracts

export type RequestOf<K extends MessageKind> = MessageContracts[K]['request']
export type ResponseOf<K extends MessageKind> = MessageContracts[K]['response']

/** То, что реально летит через chrome.runtime.sendMessage. */
export interface MessageEnvelope<K extends MessageKind = MessageKind> {
  source: typeof MESSAGE_SOURCE
  kind: K
  payload: RequestOf<K>
}

/** Обработчики на стороне получателя. Реализовывать можно не все сразу. */
export type MessageHandlers = {
  [K in MessageKind]?: (
    payload: RequestOf<K>,
    sender: chrome.runtime.MessageSender,
  ) => ResponseOf<K> | Promise<ResponseOf<K>>
}
