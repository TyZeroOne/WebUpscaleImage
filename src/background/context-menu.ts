import type { EnhanceOperation } from '@/core/enhance'
import { t } from '@/core/i18n'
import { createLogger } from '@/core/log'
import { sendToTab } from '@/core/messaging'

/**
 * Пункты контекстного меню по правому клику.
 *
 * Зачем они вдобавок к кнопкам при наведении:
 *  - кнопки появляются по hover, а наведения не существует на сенсорных экранах;
 *  - кнопки недоступны с клавиатуры, а контекстное меню открывается клавишей
 *    Menu или Shift+F10;
 *  - Chrome сам определяет, что под курсором картинка (contexts: ['image']),
 *    и делает это надёжнее нашего хит-теста — в том числе внутри iframe.
 */

const log = createLogger('context-menu')

/**
 * Пункты описаны данными, а не двумя copy-paste блоками.
 *
 * Их было четыре, пока существовал режим «вся страница». Осталось два —
 * два действия над одной картинкой. Списком по-прежнему короче и,
 * главное, невозможно создать пункт и забыть его обработать.
 */
interface MenuItem {
  id: string
  titleKey: string
  operation: EnhanceOperation
}

const ITEMS: MenuItem[] = [
  { id: 'image-enhancer:image-upscale', titleKey: 'menuEnhanceImage', operation: 'upscale' },
  { id: 'image-enhancer:image-refine', titleKey: 'menuRefineImage', operation: 'refine' },
]

const BY_ID = new Map(ITEMS.map((item) => [item.id, item]))

export function registerContextMenu(): void {
  /**
   * Пункты создаются ТОЛЬКО в onInstalled.
   *
   * Ловушка MV3: service worker выгружается и поднимается заново, и код
   * верхнего уровня выполняется при каждом подъёме. Вызов create() на верхнем
   * уровне модуля привёл бы к ошибке «Cannot create item with duplicate id»
   * на втором и каждом следующем старте.
   *
   * Пункты меню, в отличие от переменных, переживают выгрузку worker'а —
   * их хранит браузер. Поэтому создавать их повторно и не нужно.
   */
  chrome.runtime.onInstalled.addListener(() => {
    // removeAll перед create — на случай обновления расширения, когда старые
    // пункты с теми же id уже зарегистрированы браузером.
    chrome.contextMenus.removeAll(() => {
      for (const item of ITEMS) {
        chrome.contextMenus.create({
          id: item.id,
          title: t(item.titleKey),
          /**
           * Только 'image': правый клик по <img>, Chrome кладёт адрес
           * в info.srcUrl. На пустом месте страницы пунктов больше нет —
           * обрабатывать нечего, картинка не выбрана.
           */
          contexts: ['image'],
        })
      }
    })
  })

  // А вот слушатель регистрируется при каждом подъёме worker'а, синхронно:
  // без него клик по пункту меню будет некому обработать.
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const item = BY_ID.get(String(info.menuItemId))
    if (!item) return

    if (tab?.id === undefined) {
      log.warn('Клик по пункту меню без вкладки — игнорирую')
      return
    }

    if (!info.srcUrl) {
      log.warn('В событии нет srcUrl — игнорирую')
      return
    }

    /**
     * frameId из события передаётся дальше, хотя content script у нас
     * внедряется только в главный фрейм (all_frames: false). Если картинка
     * была в iframe, frameId будет ненулевым, сообщение не доставится,
     * и sendToTab честно вернёт null — это лучше, чем молча отправить
     * в главный фрейм и получить «картинка не найдена».
     */
    void sendToTab(
      tab.id,
      'CONTEXT_MENU_ENHANCE',
      { srcUrl: info.srcUrl, operation: item.operation },
      info.frameId ?? 0,
    ).then((response) => {
      if (response?.handled) return
      log.warn('Вкладка не обработала выбор из контекстного меню', {
        frameId: info.frameId,
        srcUrl: info.srcUrl,
      })
    })
  })
}
