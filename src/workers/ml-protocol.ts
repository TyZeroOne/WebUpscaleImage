/**
 * Контракт обмена с ML-воркером.
 *
 * Вынесен в отдельный файл, потому что его импортируют обе стороны:
 * сам воркер и клиент в content script. Сборки у них разные
 * (воркер собирается отдельной конфигурацией Vite), и без общего файла
 * форма сообщений разъехалась бы молча.
 */

/**
 * Всё, что отличает одну модель от другой при инференсе.
 *
 * Добавлено вместе с третьей моделью. До неё все параметры были константами:
 * увеличение вдвое, диапазон входа 0..255, стандартные слои. С появлением
 * RRDN-модели каждое из трёх перестало быть общим, и притворяться, что это
 * константы, стало нельзя.
 */
export interface MlModelSpec {
  /** Абсолютный chrome-extension:// URL к model.json. */
  url: string
  /** Во сколько раз модель увеличивает картинку. Свойство архитектуры. */
  scale: number
  /**
   * Верхняя граница диапазона входа: 255 или 1.
   *
   * Это свойство обучения, а не общее правило. У RDN-моделей вход 0..255,
   * у RRDN — 0..1. Ошибка здесь не даёт видимого мусора: сеть с глобальным
   * residual вырождается в обычное растяжение (подробно — в гайде этапа 5).
   */
  inputMax: number
  /**
   * Нужны ли самописные слои MultiplyBeta и PixelShuffle.
   *
   * У RRDN они есть (40 и 1 штука соответственно), у RDN — нет.
   * Без регистрации loadLayersModel падает с «Unknown layer».
   */
  customLayers: boolean
  /** Сторона плитки, на которые режется картинка. Зависит от глубины сети. */
  tileSize: number
  /** Ширина полей вокруг плитки: должна покрывать рецептивное поле. */
  tileOverlap: number
}

export interface MlInitRequest {
  type: 'init'
  model: MlModelSpec
  /** Каталог с .wasm-бинарниками бэкенда TensorFlow.js, со слешем на конце. */
  wasmBaseUrl: string
  /** Пробовать ли WebGPU. Решение принимает вызывающая сторона по детекции устройства. */
  preferWebgpu: boolean
}

export interface MlEnhanceRequest {
  type: 'enhance'
  id: number
  /** Передаётся как transferable. */
  bitmap: ImageBitmap
  /**
   * Сила нерезкого маскирования в процентах, 0 — выключено.
   *
   * Делается здесь, а не после получения результата: воркер уже держит
   * собранный холст, и лишние декодирование с кодированием не нужны.
   */
  sharpen: number
}

export type MlRequest = MlInitRequest | MlEnhanceRequest

export interface MlReadyResponse {
  type: 'ready'
  backend: string
  /** Сколько заняли выбор бэкенда, загрузка весов и прогрев. */
  loadMs: number
  /** Во сколько раз увеличивает загруженная модель. */
  scale: number
}

export interface MlInitFailedResponse {
  type: 'init-failed'
  error: string
}

export interface MlDoneResponse {
  type: 'done'
  id: number
  blob: Blob
  width: number
  height: number
  durationMs: number
  backend: string
}

export interface MlFailedResponse {
  type: 'failed'
  id: number
  error: string
}

export type MlResponse =
  | MlReadyResponse
  | MlInitFailedResponse
  | MlDoneResponse
  | MlFailedResponse

/**
 * Наименьшее увеличение, при котором вообще стоит звать модель.
 *
 * Ниже полутора крат результат всё равно пришлось бы уменьшать после неё,
 * а модель — самая дорогая часть пайплайна.
 */
export const ML_MIN_SCALE = 1.5
