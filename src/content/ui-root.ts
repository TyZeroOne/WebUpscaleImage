import contentCss from '@/ui/styles/content.css?inline'

/**
 * Корень всего UI, который расширение рисует поверх чужой страницы.
 *
 * Задача сложнее, чем кажется: нам нужно показать свои элементы на странице,
 * про которую мы не знаем ничего. У неё может быть свой `* { box-sizing }`,
 * `button { all: unset }`, `div { display: none }` — и любая такая строчка
 * сломает наш интерфейс. Верно и обратное: наши стили не должны менять вид
 * сайта.
 *
 * Решение — Shadow DOM. Он создаёт границу, через которую CSS не проходит
 * ни в одну, ни в другую сторону.
 */

const HOST_TAG = 'image-enhancer-root'

export interface UiRoot {
  /** Элемент-хозяин в DOM страницы. Нужен для проверок «курсор над нашим UI». */
  host: HTMLElement
  /** Слой, в который добавляются элементы UI. */
  layer: HTMLElement
}

let cached: UiRoot | null = null

export function getUiRoot(): UiRoot {
  if (cached) return cached

  const host = document.createElement(HOST_TAG)

  /**
   * Инлайновые стили с !important, а не класс.
   *
   * Стили страницы к содержимому shadow root не пробиваются, но к самому
   * host-элементу — вполне: он обычный узел в DOM страницы. Правило вида
   * `body * { position: static !important }` (такое встречается в «режимах
   * чтения» и на страницах с печатными стилями) сместило бы весь наш UI.
   * Инлайновое объявление с !important побеждает любое правило из таблицы
   * стилей страницы.
   */
  const hostStyle: Record<string, string> = {
    position: 'fixed',
    inset: '0',
    // 2147483647 — максимальное 32-битное знаковое число, максимально
    // возможный z-index. Сайты нередко используют значения вроде 9999999,
    // и перебить их можно только предельным.
    'z-index': '2147483647',
    // Слой не должен перехватывать клики по странице.
    'pointer-events': 'none',
    display: 'block',
    margin: '0',
    padding: '0',
    border: '0',
    visibility: 'visible',
    opacity: '1',
    transform: 'none',
    filter: 'none',
  }
  for (const [prop, value] of Object.entries(hostStyle)) {
    host.style.setProperty(prop, value, 'important')
  }

  /**
   * closed в проде, open в разработке.
   *
   * closed означает, что `host.shadowRoot` возвращает null: скрипты страницы
   * не смогут добраться до нашего UI и что-нибудь в нём сломать (случайно
   * или намеренно — например, скрыть кнопку скачивания).
   *
   * Но closed shadow root не разворачивается в панели Elements DevTools,
   * а верстать вслепую невозможно. Поэтому в dev-сборке режим open.
   * Разница видна только разработчику и не влияет на поведение.
   */
  const shadow = host.attachShadow({ mode: import.meta.env.DEV ? 'open' : 'closed' })

  const style = document.createElement('style')
  style.textContent = contentCss
  shadow.append(style)

  const layer = document.createElement('div')
  layer.className = 'layer'
  shadow.append(layer)

  /**
   * Вставляем в documentElement (<html>), а не в <body>.
   *
   * Некоторые сайты (SPA, «режимы чтения», страницы ошибок) заменяют
   * содержимое body целиком — вместе с нашим узлом. documentElement
   * переживает такие замены.
   */
  document.documentElement.append(host)

  cached = { host, layer }
  return cached
}
