const $ = selector => document.querySelector(selector);
const money = cents => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100);
let csrf, current = {state: 'NEW'}, busy = false, revision = 0;
const terminal = new Set(['NEW', 'SETTLED', 'NO_AGREEMENT', 'CANCELLED', 'EXPIRED']);

async function api(operation, body) {
  const response = await fetch(`/commerce/api/${operation}`, {
    credentials: 'same-origin', cache: 'no-store',
    ...(body ? {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Commerce-CSRF': csrf}, body: JSON.stringify(body)} : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function departure(arrival) {
  const day = new Date(`${arrival}T12:00:00Z`);
  if (!Number.isFinite(day.getTime())) return '';
  day.setUTCDate(day.getUTCDate() + 2);
  return day.toISOString().slice(0, 10);
}

function updateDates() {
  $('#departure').textContent = `Departure: ${departure($('#mandate').elements.arrival.value)} · Two adults · Parking & Wi-Fi`;
}

function text(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

function button(label, operation, extra = {}, secondary = false) {
  const node = text('button', label, secondary ? 'secondary' : '');
  node.type = 'button';
  node.disabled = busy;
  node.addEventListener('click', () => perform(operation, {deal_id: current.deal_id, ...extra}));
  $('#actions').append(node);
}

const descriptions = {
  NEW: 'Create a private mandate to start. Nothing is booked or charged.',
  OPEN: 'Your mandate is recorded. Ask the Inn to commit its sealed policy bid through the arbiter.',
  NEGOTIATING: 'The arbiter computed this offer from your mandate and the Inn’s sealed bid. Review the exact terms before approving.',
  HELD: 'You approved this offer. Simulated funds are held for 120 seconds. Confirm fixture inventory to settle, or release the hold.',
  SETTLED: 'The simulated transaction is complete. Retrying confirmation cannot create a second charge.',
  NO_AGREEMENT: 'No seller bid fits your private mandate. Nothing was booked or charged. You may create a new mandate.',
  CANCELLED: 'The transaction was cancelled and any hold released. Nothing was charged.',
  EXPIRED: 'The 120-second hold expired and funds were released. Create a new mandate to try again.',
};

function render() {
  const form = $('#mandate');
  if (current.trip && !terminal.has(current.state)) {
    form.elements.arrival.value = current.trip.arrival;
    form.elements.budget.value = (current.budget_cents / 100).toFixed(2);
    updateDates();
  }
  for (const control of form.elements) control.disabled = busy || !csrf || !terminal.has(current.state);
  $('#create').textContent = current.deal_id ? 'Create a new private mandate' : 'Create private mandate';
  $('.outcome').setAttribute('aria-busy', String(busy));
  $('#state').textContent = current.state.replaceAll('_', ' ');
  $('#explanation').textContent = descriptions[current.state] || current.state;
  $('#totals').textContent = current.deal_id ? `Held: ${money(current.hold_cents)} · Spent: ${money(current.spent_cents)}` : '';
  $('#offer').replaceChildren(); $('#actions').replaceChildren(); $('#receipt').replaceChildren();
  const offer = current.offers?.find(item => item.offer_id === current.selected_offer_id) || current.offers?.[0];
  if (offer) {
    $('#offer').append(text('p', money(offer.total_cents), 'price'),
      text('p', `${money(offer.savings_cents)} below the ${money(offer.list_cents)} catalogue price.`, 'hint'),
      text('p', `${offer.trip.arrival} → ${offer.trip.departure}. ${offer.scope}`, 'offer-terms'),
      text('p', offer.cancellation, 'offer-terms'),
      text('p', `Offer expires ${new Date(offer.expires_at * 1000).toLocaleString()}.`, 'hint'));
    const lines = document.createElement('ul');
    for (const item of offer.line_items) lines.append(text('li', `${item.label}: ${money(item.cents)}`));
    lines.className = 'offer-terms'; $('#offer').append(lines);
  }
  if (current.state === 'OPEN' || (current.state === 'NEGOTIATING' && !offer)) button('Ask the Inn to negotiate', 'negotiate');
  if (current.state === 'NEGOTIATING' && offer) button(`Approve & hold ${money(offer.total_cents)}`, 'authorize', {offer_id: offer.offer_id});
  if (current.state === 'HELD') {
    button('Confirm inventory & settle', 'confirm');
    button('Simulate inventory failure', 'fail-inventory', {}, true);
  }
  if (['OPEN', 'NEGOTIATING', 'HELD'].includes(current.state)) button('Cancel & release', 'cancel', {}, true);
  if (current.receipt) $('#receipt').append(text('h3', 'Simulated receipt'), text('p', `${current.receipt.reservation} · Paid ${money(current.receipt.paid_cents)} to Seabreeze Inn`));
  $('#audit').textContent = current.deal_id ? JSON.stringify(current, null, 2) : 'No transaction yet.';
  $('#download').disabled = !current.deal_id;
}

async function perform(operation, body) {
  if (busy) return;
  revision += 1;
  busy = true; $('#error').hidden = true; render();
  try { current = await api(operation, body); }
  catch (error) { $('#error').textContent = error.message; $('#error').hidden = false; }
  finally { busy = false; render(); }
}

$('#mandate').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const budget = form.elements.budget.value;
  if (!/^\d+(\.\d{1,2})?$/.test(budget)) {
    $('#error').textContent = 'Enter a USD amount with at most two decimal places.';
    $('#error').hidden = false; return;
  }
  const arrival = form.elements.arrival.value;
  perform('create', {budget_cents: Math.round(Number(budget) * 100), trip: {
    destination: 'Cailville', arrival, departure: departure(arrival), travelers: 2, amenities: ['parking', 'wifi'],
  }});
});
$('#mandate').elements.arrival.addEventListener('input', updateDates);
$('#download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = `private-commerce-audit-${current.deal_id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

try {
  const [info, session] = await Promise.all([api('info'), api('session')]);
  csrf = session.csrf; delete session.csrf; current = session;
  $('#catalog').textContent = `${money(info.catalog.total_cents)} fixed catalogue price. ${info.catalog.scope}`;
  $('#seller-link').href = info.seller_url;
  const form = $('#mandate');
  form.elements.arrival.value = current.trip?.arrival || info.catalog.trip.arrival;
  if (current.budget_cents) form.elements.budget.value = (current.budget_cents / 100).toFixed(2);
  const today = new Date();
  form.elements.arrival.min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  updateDates(); render();
  // Read-only refresh releases expired holds and recovers changes made in another tab.
  setInterval(async () => {
    if (busy) return;
    const startedAt = revision;
    try {
      const session = await api('session');
      if (busy || startedAt !== revision) return;
      csrf = session.csrf; delete session.csrf;
      // Preserve keyboard focus and avoid replacing action buttons when a poll
      // reports unchanged state. An expired hold or another tab still refreshes.
      if (JSON.stringify(session) !== JSON.stringify(current)) {
        current = session; render();
      }
    } catch { /* The next explicit action reports connectivity failures. */ }
  }, 5000);
} catch (error) {
  $('#state').textContent = 'Checkout unavailable';
  $('#explanation').textContent = 'Start the arbiter site, then reload this page.';
  $('#error').textContent = error.message; $('#error').hidden = false;
}
