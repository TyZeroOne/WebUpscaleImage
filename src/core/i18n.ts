/**
 * Локализация.
 *
 * Тонкая обёртка над chrome.i18n.getMessage. Нужна по трём причинам:
 *
 *  1. Опечатка в ключе у getMessage возвращает ПУСТУЮ СТРОКУ, а не ошибку.
 *     В интерфейсе это выглядит как исчезнувшая надпись, и понять, что дело
 *     в ключе, тяжело. Обёртка возвращает сам ключ — сразу видно, где промах.
 *  2. Один вызов на весь проект удобно подменить в тестовом стенде, где
 *     chrome.i18n нет.
 *  3. Заполнение статической разметки: в HTML-страницах расширения строки
 *     нельзя написать текстом, их подставляет скрипт.
 */

export function t(key: string, ...substitutions: (string | number)[]): string {
  const message = chrome.i18n?.getMessage(key, substitutions.map(String))
  /**
   * Пустая строка означает, что ключа нет в messages.json. Возвращаем ключ:
   * лучше увидеть в интерфейсе «popupQuality», чем пустое место.
   */
  return message || key
}

/**
 * Заполнение статической разметки.
 *
 * Ищет элементы с data-i18n и подставляет в них текст. Для атрибутов —
 * data-i18n-attr в формате «атрибут:ключ», через запятую.
 *
 * Так сделано потому, что HTML-страницы расширения не поддерживают
 * подстановку сообщений сами (в отличие от manifest.json, где работает
 * запись __MSG_key__).
 */
export function applyI18n(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset.i18n
    if (key) node.textContent = t(key)
  }

  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of (node.dataset.i18nAttr ?? '').split(',')) {
      const [attribute, key] = pair.split(':').map((part) => part.trim())
      if (attribute && key) node.setAttribute(attribute, t(key))
    }
  }

  // Заголовок вкладки: важен для страницы настроек, открывающейся отдельно.
  const title = document.querySelector('title')
  if (title?.dataset.i18n) document.title = t(title.dataset.i18n)
}
