import type { ElicitationRequest } from '../types/events.js';

export function canAcceptElicitation(req: Pick<ElicitationRequest, 'mode'>): boolean {
  return req.mode === 'url';
}
