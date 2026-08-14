import type { TargetSize } from '@/core/enhance'
import { t } from '@/core/i18n'

/**
 * Диалог выбора целевого разрешения для одной картинки.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В НАСТРОЙКАХ
 *
 * В настройках уже есть «привести длинную сторону к N пикселям» — и это
 * другая задача. Настройка описывает привычку («мне обычно нужно 1920»),
 * а этот диалог — разовое решение про конкретную картинку. Прятать разовое
 * решение в глобальные настройки значит заставлять пользователя менять их
 * туда-обратно.
 *
 * ПОЧЕМУ НЕТ ПЕРЕКЛЮЧАТЕЛЯ «УВЕЛИЧИТЬ / УМЕНЬШИТЬ»
 *
 * Направление однозначно выводится сравнением цели с текущим размером,
 * и переключатель мог бы только противоречить введённым числам. Вместо него
 * диалог ПОКАЗЫВАЕТ выведенное направление — пользователь видит, что
 * получится, до того как нажмёт.
 */

/** Отступ от края картинки, px. Такой же, как у группы кнопок. */
const INSET_PX = 8

/**
 * Пресеты — распространённые размеры экранов, а не «красивые числа».
 *
 * Смысл пресета в том, чтобы попасть в размер, под который картинку будут
 * смотреть. Поэтому здесь 1080p, 1440p и 4K, а не 1000×1000 и 2000×2000.
 */
const PRESETS: TargetSize[] = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
]

/**
 * Границы ручного ввода.
 *
 * Нижняя — чтобы случайный ноль не превратил картинку в точку. Верхняя
 * согласована с потолком памяти в canvas-enhancer.ts: 24 мегапикселя,
 * то есть сторона больше 8192 осмысленна только при очень узкой второй.
 */
const MIN_SIDE = 16
const MAX_SIDE = 8192

export interface SizeDialog {
  /** Открыть у картинки с указанным исходным размером. */
  open(rect: DOMRect, source: TargetSize): void
  close(): void
  isOpen(): boolean
  onApply(handler: (target: TargetSize) => void): void
  readonly element: HTMLElement
}

/**
 * Вписать исходный размер в рамку пресета с сохранением пропорций.
 *
 * Пресет — это рамка, а не точный размер результата: у картинки 4:3
 * и рамки 16:9 совпасть могут только стороны, но не обе сразу. Растянуть
 * картинку под рамку было бы искажением, которого никто не просил,
 * поэтому вписываем.
 */
function fitInside(source: TargetSize, box: TargetSize): TargetSize {
  const factor = Math.min(box.width / source.width, box.height / source.height)
  return {
    width: Math.max(1, Math.round(source.width * factor)),
    height: Math.max(1, Math.round(source.height * factor)),
  }
}

function clampSide(value: number): number {
  if (!Number.isFinite(value)) return MIN_SIDE
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(value)))
}

export function createSizeDialog(layer: HTMLElement): SizeDialog {
  const root = document.createElement('div')
  root.className = 'size-dialog'
  root.dataset.visible = 'false'

  const title = document.createElement('div')
  title.className = 'size-title'
  title.textContent = t('sizeDialogTitle')

  const source = document.createElement('div')
  source.className = 'size-source'

  const presetRow = document.createElement('div')
  presetRow.className = 'size-presets'

  const inputs = document.createElement('div')
  inputs.className = 'size-inputs'

  const widthInput = document.createElement('input')
  const heightInput = document.createElement('input')
  for (const input of [widthInput, heightInput]) {
    input.type = 'number'
    input.min = String(MIN_SIDE)
    input.max = String(MAX_SIDE)
    input.className = 'size-field'
  }
  widthInput.setAttribute('aria-label', t('sizeWidth'))
  heightInput.setAttribute('aria-label', t('sizeHeight'))

  const times = document.createElement('span')
  times.className = 'size-times'
  times.textContent = '×'

  const lockLabel = document.createElement('label')
  lockLabel.className = 'size-lock'
  const lock = document.createElement('input')
  lock.type = 'checkbox'
  lock.checked = true
  const lockText = document.createElement('span')
  lockText.textContent = t('sizeKeepRatio')
  lockLabel.append(lock, lockText)

  inputs.append(widthInput, times, heightInput)

  const verdict = document.createElement('div')
  verdict.className = 'size-verdict'

  const buttons = document.createElement('div')
  buttons.className = 'size-buttons'
  const apply = document.createElement('button')
  apply.type = 'button'
  apply.className = 'size-apply'
  apply.textContent = t('sizeApply')
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = t('sizeCancel')
  buttons.append(apply, cancel)

  root.append(title, source, presetRow, inputs, lockLabel, verdict, buttons)
  layer.append(root)

  let current: TargetSize = { width: 0, height: 0 }
  let handler: ((target: TargetSize) => void) | null = null

  const ratio = (): number => (current.height === 0 ? 1 : current.width / current.height)

  const readTarget = (): TargetSize => ({
    width: clampSide(Number(widthInput.value)),
    height: clampSide(Number(heightInput.value)),
  })

  /**
   * Направление и коэффициент показываются словами и числом.
   *
   * Именно здесь пользователь узнаёт, что 1920 для его картинки 400×300 —
   * это увеличение впятеро, а вовсе не «привести к стандарту».
   */
  const renderVerdict = (): void => {
    const target = readTarget()
    const factor = target.width / Math.max(1, current.width)
    if (Math.abs(factor - 1) < 0.005) {
      verdict.textContent = t('sizeSame')
      verdict.dataset.direction = 'same'
      apply.disabled = true
      return
    }
    apply.disabled = false
    const shrinking = factor < 1
    verdict.dataset.direction = shrinking ? 'down' : 'up'
    verdict.textContent = t(
      shrinking ? 'sizeVerdictDown' : 'sizeVerdictUp',
      factor.toFixed(factor < 1 ? 2 : 1),
    )
  }

  const setTarget = (target: TargetSize): void => {
    widthInput.value = String(target.width)
    heightInput.value = String(target.height)
    renderVerdict()
  }

  widthInput.addEventListener('input', () => {
    if (lock.checked) heightInput.value = String(clampSide(Number(widthInput.value) / ratio()))
    renderVerdict()
  })
  heightInput.addEventListener('input', () => {
    if (lock.checked) widthInput.value = String(clampSide(Number(heightInput.value) * ratio()))
    renderVerdict()
  })
  lock.addEventListener('change', () => {
    // Включили сохранение пропорций — приводим высоту к ширине сразу,
    // а не при следующем вводе: иначе галочка выглядит неработающей.
    if (lock.checked) heightInput.value = String(clampSide(Number(widthInput.value) / ratio()))
    renderVerdict()
  })

  for (const preset of PRESETS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'size-preset'
    button.textContent = `${preset.width}×${preset.height}`
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      setTarget(fitInside(current, preset))
    })
    presetRow.append(button)
  }

  const close = (): void => {
    root.dataset.visible = 'false'
    root.style.top = '-9999px'
  }

  cancel.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    close()
  })

  apply.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const target = readTarget()
    close()
    handler?.(target)
  })

  /**
   * Клик и клавиши гасятся на уровне всего диалога.
   *
   * Причина та же, что у кнопок: события всплывают до document, где их видят
   * делегированные обработчики страницы. Особенно вредно это для клавиш —
   * многие сайты вешают на них горячие клавиши, и набор «1920» в поле
   * запросто пролистал бы галерею.
   */
  for (const type of ['click', 'keydown', 'keyup', 'pointerdown'] as const) {
    root.addEventListener(type, (event) => {
      event.stopPropagation()
      if (type === 'keydown' && (event as KeyboardEvent).key === 'Escape') close()
    })
  }

  return {
    element: root,

    open(rect, sourceSize) {
      current = sourceSize
      source.textContent = t('sizeSource', `${sourceSize.width}×${sourceSize.height}`)
      setTarget(sourceSize)

      /**
       * Диалог позиционируется под группой кнопок и прижимается к правому
       * краю картинки, но не вылезает за окно: у маленькой картинки
       * в углу экрана он иначе оказался бы наполовину за кадром.
       */
      const width = 240
      const left = Math.min(
        Math.max(INSET_PX, rect.right - width - INSET_PX),
        document.documentElement.clientWidth - width - INSET_PX,
      )
      root.style.left = `${Math.max(INSET_PX, left)}px`
      root.style.top = `${Math.max(INSET_PX, rect.top + INSET_PX)}px`
      root.dataset.visible = 'true'
      widthInput.focus()
    },

    close,
    isOpen: () => root.dataset.visible === 'true',
    onApply(next) {
      handler = next
    },
  }
}
