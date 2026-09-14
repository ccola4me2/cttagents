// The reservation board.
//
// This was two boards behind one picker: the portal's own reservations, and
// whatever pipelines the CRM held. The CRM is gone and only the good half is
// left, which is the half that could never be wrong: a card's stage is worked
// out from the reservation every time the page loads, rather than being a copy
// somebody has to remember to drag.
import { json, clean } from './util.js';
import { requireUser } from './auth.js';
import * as db from './db.js';

export async function handleListOpportunities(request, env) {
  const { user, response } = await requireUser(request, env);
  if (response) return response;

  const url = new URL(request.url);
  const RESERVATIONS = { id: 'reservations', name: 'Reservations' };

  // Scoped like every other reading screen: an advisor sees their own, an
  // owner sees whoever the picker says. Writes are elsewhere and are always
  // the caller's own, so widening this cannot widen what anybody can change.
  const scope = db.scopeFor(env, user, request);
  const today = new Date().toISOString().slice(0, 10);
  const query = clean(url.searchParams.get('q'), 80);
  let cards = await db.reservationPipeline(env, scope, today);
  if (query) {
    const needle = query.toLowerCase();
    cards = cards.filter((c) => c.name.toLowerCase().includes(needle));
  }

  const stages = db.RESERVATION_STAGES.map((st, i) => {
    const items = cards.filter((c) => c.stageId === st.id);
    return {
      ...st,
      position: i,
      count: items.length,
      valueTotal: items.reduce((sum, c) => sum + c.monetaryValue, 0),
      opportunities: items,
    };
  });

  return json({
    pipelines: [RESERVATIONS],
    pipeline: RESERVATIONS,
    stages,
    total: cards.length,
    // The stage is worked out from the reservation, so dragging a card would be
    // a change the next load undoes. The board says so rather than offering a
    // control that silently does nothing.
    derived: true,
    scope: db.scopeLabel(scope, user),
    advisors: await db.advisorOptions(env, user),
  });
}
