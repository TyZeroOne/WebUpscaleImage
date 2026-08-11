/**
 * Контракт обмена с ML-воркером.
 *
 * Вынесен в отдельный файл, потому что его импортируют обе стороны:
 * сам воркер и клиент в content script. Сборки у них разные
 * (воркер собирается отдельной конфигурацией Vite), и без общего файла
 * форма сообщений разъехалась бы молча.
 */

export interface MlInitRequest {
  type: 'init'
  /** Абсолютный chrome-extension:// URL к model.json. */
  modelUrl: string
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
}

export type MlRequest = MlInitRequest | MlEnhanceRequest

export interface MlReadyResponse {
  type: 'ready'
  backend: string
  /** Сколько заняли выбор бэкенда, загрузка весов и прогрев. */
  loadMs: number
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
 * Модель увеличивает ровно вдвое — это зашито в её архитектуру
 * (слой PixelShuffle2x), а не является настройкой.
 */
export const ML_SCALE = 2

/**
 * Потолок размера входа для ML, в пикселях.
 *
 * Ограничение по времени и памяти. ESRGAN даже в облегчённом варианте —
 * это два десятка свёрточных слоёв, и стоимость растёт линейно по числу
 * пикселей. На WASM-бэкенде картинка в мегапиксель считается секундами;
 * выше начинается время, которое пользователь воспримет как зависание.
 *
 * Картинки крупнее обрабатываются классическим апскейлом — он не «хуже»,
 * он просто другой: у большой картинки уже достаточно деталей, и выигрыш
 * от ML там меньше всего.
 */
export const ML_MAX_INPUT_PIXELS = 1_000_000
