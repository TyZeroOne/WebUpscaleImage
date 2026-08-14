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

import type { EnhanceOperation } from '@/core/enhance/types'

/** Откуда пришёл запрос на улучшение — влияет на то, как показывать результат. */
export type EnhanceTrigger = 'overlay' | 'context-menu' | 'page'

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

  /**
   * Пользователь попросил улучшить конкретную картинку.
   *
   * Этап 2: сообщение информационное — сама обработка идёт в content script,
   * а service worker лишь пишет о ней в лог. Этап 4 сделает его настоящей
   * передачей задачи в offscreen-документ, и форма запроса не изменится.
   */
  ENHANCE_IMAGE: {
    request: {
      sourceUrl: string
      naturalWidth: number
      naturalHeight: number
      trigger: EnhanceTrigger
    }
    response: { received: true }
  }

  /** Popup спрашивает у вкладки, что на ней есть. Идёт через chrome.tabs.sendMessage. */
  SCAN_PAGE: {
    request: Record<string, never>
    response: { url: string; images: number; videos: number }
  }

  /** Service worker передаёт во вкладку выбор пункта контекстного меню. */
  CONTEXT_MENU_ENHANCE: {
    request: { srcUrl: string; operation: EnhanceOperation }
    response: { handled: boolean }
  }

  /**
   * Загрузка картинки силами расширения, в обход CORS.
   *
   * Content script не может обойти CORS: его запросы подчиняются правилам
   * страницы. Service worker с host_permissions — может, его запросы
   * CORS не ограничивает.
   *
   * Ответ приходит строкой data: URL, а не двоичными данными: канал
   * сообщений сериализует всё в JSON, и ни Blob, ни ArrayBuffer через него
   * не проходят.
   */
  FETCH_IMAGE: {
    request: { url: string }
    response:
      | { ok: true; dataUrl: string; bytes: number }
      | { ok: false; reason: 'network' | 'too-large' | 'not-image' | 'unsupported-scheme' }
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
