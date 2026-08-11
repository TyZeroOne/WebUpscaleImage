import type { QualityLevel } from './types'

/**
 * Правила, по которым уровень качества превращается в конкретные действия.
 *
 * Вынесено отдельным модулем намеренно. Раньше эти решения были размазаны:
 * радиус фильтра выбирался в canvas-enhancer, применимость ML — в ml-client,
 * коэффициент увеличения — в core/enhance/index. Пока правило было одно
 * на каждое место, это работало; с появлением трёх уровней их стало нужно
 * согласовывать между собой, а согласовывать проще то, что лежит рядом.
 */

/** Что именно делать с картинкой. */
export interface EnhancePlan {
  /** Пробовать ли ML. Даже при true он может не подойти по размеру. */
  useMl: boolean
  /** Радиус фильтра Ланцоша, либо null — масштабировать средствами браузера. */
  lanczosRadius: number | null
  /** Потолок коэффициента увеличения. */
  maxScale: number
}

/**
 * Уровни отличаются не «качеством вообще», а тем, чем разрешено платить
 * за результат.
 *
 * fast         — только средства браузера. Масштабирование выполняется
 *                нативным кодом и обычно на видеокарте, стоит единицы
 *                миллисекунд. Результат мягкий.
 * balanced     — фильтр Ланцоша с радиусом 2 (замер: 253 мс на
 *                1920×1080 → 3840×2160). ML разрешён только на WebGPU:
 *                на WASM он стоил бы секунды.
 * quality      — Ланцош с радиусом 3 (325 мс на том же размере) и ML
 *                на любом доступном бэкенде.
 */
const PLANS: Record<QualityLevel, EnhancePlan> = {
  fast: { useMl: false, lanczosRadius: null, maxScale: 2 },
  balanced: { useMl: true, lanczosRadius: 2, maxScale: 3 },
  quality: { useMl: true, lanczosRadius: 3, maxScale: 4 },
}

export function resolvePlan(level: QualityLevel): EnhancePlan {
  return PLANS[level]
}

/**
 * Разрешён ли ML на этом бэкенде при этом уровне.
 *
 * Разделено с resolvePlan, потому что бэкенд выясняется позже уровня:
 * узнать его можно только подняв воркер и попробовав инициализацию.
 *
 * Смысл правила: на «сбалансированно» пользователь просит разумный
 * компромисс, а ML на WASM — это секунды ожидания на средней картинке.
 * Обещать компромисс и заставлять ждать три секунды нечестно.
 */
export function isMlAllowed(level: QualityLevel, backend: string): boolean {
  if (!resolvePlan(level).useMl) return false
  if (level === 'balanced') return backend === 'webgpu'
  return true
}
