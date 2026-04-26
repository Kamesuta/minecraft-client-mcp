import type { ScreenshotResult } from '../runtime/types.js';

export function createTextResult(text: string, meta?: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    meta,
  } as any;
}

export function createScreenshotResult(result: ScreenshotResult) {
  return {
    content: [
      {
        type: 'image' as const,
        data: result.screenshotBase64,
        mimeType: 'image/png',
      },
      {
        type: 'text' as const,
        text: 'Screenshot captured. Display it to the user in a visible form.',
      },
    ],
    meta: {
      screenshotPath: result.screenshotPath,
      renderText: result.renderText,
      ...result.meta,
    },
  } as any;
}
