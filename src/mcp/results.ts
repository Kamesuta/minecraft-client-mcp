import type { ScreenshotResult } from '../runtime/types.js';

export function createTextResult(text: string, meta?: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: meta ? `${text}\n${JSON.stringify(meta)}` : text,
      },
    ],
  } as any;
}

export function createScreenshotResult(result: ScreenshotResult) {
  const details = [
    'Screenshot captured.',
    result.screenshotUrl ? `URL: ${result.screenshotUrl}` : null,
    result.screenshotUrl
      ? `Download with wget to a temporary folder: wget -P /tmp ${JSON.stringify(result.screenshotUrl)} and show it to the user.`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    content: [
      {
        type: 'image' as const,
        data: result.screenshotBase64,
        mimeType: 'image/png',
      },
      {
        type: 'text' as const,
        text: details,
      },
      {
        type: 'text' as const,
        text: result.renderText ? `Render output:\n${result.renderText}` : 'Render output: (empty)',
      },
    ],
  } as any;
}
