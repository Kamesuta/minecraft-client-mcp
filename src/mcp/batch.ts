import type { BatchResult } from '../runtime/types.js';

export function createBatchResult(result: BatchResult) {
  return {
    content: [
      {
        type: 'text' as const,
        text: result.message,
      },
      {
        type: 'text' as const,
        text: JSON.stringify(result.results, null, 2),
      },
    ],
  } as any;
}
