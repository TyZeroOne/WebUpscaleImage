import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Основная сборка расширения: service worker + HTML-страницы (popup, options).
 *
 * Всё, что собирается здесь, грузится браузером как ES-модули:
 *   - service worker объявлен в манифесте как "type": "module";
 *   - HTML-страницы расширения подключают скрипты как <script type="module">.
 *
 * Content script собирается ОТДЕЛЬНО (vite.content.config.ts), потому что
 * Chrome умеет исполнять content script только как классический скрипт,
 * без import/export. Подробности — в docs/01_Stage0_ProjectSetup_Guide.md.
 */
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development'

  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    // Всё из public/ копируется в dist/ как есть: manifest.json и иконки.
    publicDir: 'public',

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    build: {
      outDir: 'dist',
      // dist чистит scripts/build.mjs один раз перед обеими сборками,
      // иначе вторая сборка стёрла бы результат первой.
      emptyOutDir: false,
      target: 'chrome116',
      minify: !isDev,
      // Инлайновый sourcemap: DevTools показывает исходный TypeScript,
      // а отдельные .map-файлы не мусорят в dist и не попадают в zip.
      sourcemap: isDev ? 'inline' : false,
      // КРИТИЧНО: полифилл modulepreload Vite вставляет инлайновым <script>,
      // а CSP расширений (extension_pages) запрещает инлайновые скрипты —
      // страница просто не загрузится. Chrome 116 поддерживает modulepreload
      // нативно, полифилл не нужен.
      modulePreload: false,
      rollupOptions: {
        input: {
          background: 'src/background/index.ts',
          popup: 'pages/popup.html',
          options: 'pages/options.html',
        },
        output: {
          format: 'es',
          // Имена точек входа фиксированы без хеша: на них ссылается
          // manifest.json, а он статический.
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  }
})
