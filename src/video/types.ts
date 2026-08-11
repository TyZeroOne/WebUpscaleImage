/**
 * ЗАГЛУШКА. Контракты будущей обработки видео.
 *
 * Реализации здесь нет и в этапах 0-9 не будет — это осознанное решение,
 * зафиксированное в docs/00_Overview.md.
 *
 * Первая версия этого файла написана на этапе 0, вслепую. Этап 8 пересматривает
 * её с учётом того, что выяснилось за семь этапов работы над картинками:
 * какой транспорт возможен, сколько реально стоит инференс, как устроена отмена.
 * Изменения помечены по месту.
 */

import type { EnhanceBackend, QualityLevel } from '@/core/enhance/types'

export type VideoTaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

/**
 * Почему обработка видео может быть невозможна ещё до начала.
 *
 * Добавлено на этапе 8. На этапе 0 предполагалось, что задача либо запускается,
 * либо падает в процессе. Опыт этапов 5 и 7 показал, что бо́льшая часть отказов
 * известна заранее, и сообщать о них надо до того, как пользователь начал ждать.
 */
export type VideoRejection =
  /** Поток защищён DRM (Widevine и подобные) — кадры недоступны в принципе. */
  | 'protected'
  /** Формат контейнера или кодек не поддерживается WebCodecs в этом браузере. */
  | 'unsupported-codec'
  /** Видео отдаётся как MSE-поток из JS, а не файлом — скачать нечего. */
  | 'no-source-url'
  /** Оценка времени обработки выходит за разумные пределы. */
  | 'too-expensive'
  /** Нет ни WebGPU, ни достаточно быстрого запасного пути. */
  | 'device-too-slow'

export interface VideoEnhanceOptions {
  level: QualityLevel
  /**
   * Обрабатывать только видимый пользователю фрагмент.
   *
   * Добавлено на этапе 8. Замеры этапа 5 показали, что кадр 1280×720
   * на WebGPU стоит около 300 мс: минута видео в 30 fps — это 1800 кадров
   * и девять минут работы. Обработка целого ролика по умолчанию —
   * не то, чего ждёт пользователь, нажавший кнопку.
   */
  range: { startSec: number; endSec: number } | null
}

export interface VideoEnhanceTask {
  id: string
  /** URL источника: <video src> или разрешённый src первого <source>. */
  sourceUrl: string
  options: VideoEnhanceOptions
  status: VideoTaskStatus
  createdAt: number
}

export interface VideoProgress {
  taskId: string
  status: VideoTaskStatus
  /** Обработано кадров. Может быть неизвестно до конца декодирования. */
  framesDone: number
  framesTotal: number | null
  /** Оценка оставшегося времени в мс, null пока нечего оценивать. */
  etaMs: number | null
  /**
   * Чем считается. Добавлено на этапе 8: на видео разница между WebGPU и WASM
   * не «в разы быстрее», а «возможно или невозможно», и пользователь должен
   * это видеть.
   */
  backend: EnhanceBackend | null
}

/**
 * Оценка стоимости до запуска.
 *
 * Добавлено на этапе 8. Для картинки оценка не нужна — она считается быстрее,
 * чем пользователь успеет прочитать предупреждение. Для видео это обязательный
 * шаг: без него единственный способ узнать, что обработка займёт полчаса, —
 * подождать полчаса.
 */
export interface VideoEstimate {
  frames: number
  /** Ожидаемое время обработки, мс. Оценка по замеру одного кадра. */
  estimatedMs: number
  /** Приблизительный размер результата в байтах. */
  estimatedBytes: number
  backend: EnhanceBackend
}

export interface VideoEnhancer {
  /** Причина отказа или null, если обработка возможна. */
  check(task: VideoEnhanceTask): Promise<VideoRejection | null>

  /** Оценка по одному пробному кадру. Дешевле полной обработки на три порядка. */
  estimate(task: VideoEnhanceTask): Promise<VideoEstimate>

  start(task: VideoEnhanceTask, onProgress: (progress: VideoProgress) => void): Promise<Blob>

  /**
   * Пауза и продолжение.
   *
   * Добавлено на этапе 8. У картинок отмена реализована через terminate()
   * воркера — работа просто выбрасывается, потому что стоит доли секунды.
   * Для видео так нельзя: выбросить десять минут обработки из-за того, что
   * пользователю понадобился процессор, — неприемлемо.
   */
  pause(taskId: string): void
  resume(taskId: string): void

  cancel(taskId: string): void
}
