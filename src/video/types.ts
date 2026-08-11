/**
 * ЗАГЛУШКА. Контракты будущей обработки видео.
 *
 * Реализации здесь нет и на этапах 0-9 не будет — это осознанное решение,
 * зафиксированное в docs/00_Overview.md. Файл существует, чтобы:
 *
 *  1. Зафиксировать форму задачи и прогресса ДО того, как появится код.
 *     Прогресс видео принципиально отличается от прогресса картинки
 *     (кадры, а не «готово/не готово»), и очередь этапа 3 должна быть
 *     спроектирована так, чтобы вместить оба случая.
 *  2. Дать content script'у на что ссылаться, когда он находит <video>:
 *     элемент детектируется уже сейчас, но UI для него отключён.
 *
 * Почему обработка видео отложена: любой рабочий путь (WebCodecs, ffmpeg.wasm,
 * MediaRecorder) требует своего пайплайна декодирования, покадрового
 * планирования и упаковки обратно в контейнер. Это сопоставимо по объёму со
 * всеми этапами 0-9 вместе взятыми и не переиспользует ничего, кроме
 * собственно апскейлера кадра.
 */

import type { EnhanceOptions } from '@/core/enhance/types'

export type VideoTaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

export interface VideoEnhanceTask {
  id: string
  /** URL источника: <video src> или разрешённый src первого <source>. */
  sourceUrl: string
  options: EnhanceOptions
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
}

export interface VideoEnhancer {
  isAvailable(): Promise<boolean>
  start(task: VideoEnhanceTask, onProgress: (progress: VideoProgress) => void): Promise<Blob>
  cancel(taskId: string): void
}
