import { Store } from './store.js';
import type { GuardRequestRecord } from './types.js';

export function allPersonasAcked(req: GuardRequestRecord): boolean {
  return req.required_personas.every(p => req.persona_state[p] === 'ack');
}

export function recordPersonaAck(request_id: string, persona: string, actor: string) {
  Store.updatePersonaState(request_id, persona, 'ack', actor);
}
