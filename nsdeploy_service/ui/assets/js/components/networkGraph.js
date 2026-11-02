/**
 * One deployed network's own agent call graph — who delegates to whom inside a
 * single HOCON. Distinct from the Map view: that draws deployment-to-deployment
 * links between *different* networks; this draws the agents *inside* one.
 *
 * Nodes are laid out by BFS depth from the front-man (a simple layered tree),
 * not a force simulation — the backend gives topology only, no coordinates, and
 * a deterministic layered layout is legible without needing to settle physics
 * inside a modal.
 */
import { $, $$, esc, icon } from '../util/dom.js';
import { displayName } from '../util/format.js';

const KIND_ICON = { root: 'rocket', orchestrator: 'cpu', agent: 'cube', external: 'external' };
const KIND_LABEL = { root: 'front-man', orchestrator: 'orchestrator', agent: 'agent', external: 'hosted / external' };

/**
 * @returns {() => void} a cleanup function (disconnects the resize observer)
 */
export function renderNetworkGraph(container, graph) {
  const { nodes, edges, front_man: frontMan } = graph;
  if (!nodes?.length) {
    container.innerHTML = `<div class="empty">
      <div class="empty__title">No topology to show</div>
      <p class="empty__hint">This network has no resolved agent bundle yet.</p>
    </div>`;
    return () => {};
  }

  const children = new Map(nodes.map((node) => [node.id, []]));
  edges.forEach((edge) => children.get(edge.source)?.push(edge.target));

  // BFS layering from the front-man. Anything unreachable from it (should not
  // happen in a resolved network) still gets a row, rather than vanishing.
  const depth = new Map();
  const rootId = nodes.some((node) => node.id === frontMan) ? frontMan : nodes[0].id;
  depth.set(rootId, 0);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    for (const child of children.get(id) || []) {
      if (depth.has(child)) continue;
      depth.set(child, depth.get(id) + 1);
      queue.push(child);
    }
  }
  nodes.forEach((node) => { if (!depth.has(node.id)) depth.set(node.id, 0); });

  const rows = [];
  nodes.forEach((node) => {
    const level = depth.get(node.id);
    (rows[level] ||= []).push(node);
  });

  const position = new Map();
  const rowStep = 100 / rows.length;
  rows.forEach((row, rowIndex) => {
    const colStep = 100 / (row.length + 1);
    row.forEach((node, colIndex) => {
      position.set(node.id, { x: colStep * (colIndex + 1), y: rowStep * (rowIndex + 0.5) });
    });
  });

  container.innerHTML = `
    <div class="agentgraph" id="ag-stage" style="--ag-rows:${rows.length}">
      <svg class="agentgraph__edges" aria-hidden="true">
        <defs>
          <marker id="ag-arrow" viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z"/>
          </marker>
        </defs>
        <g id="ag-edge-paths"></g>
      </svg>
      <div class="agentgraph__nodes">
        ${nodes.map((node) => {
          const pos = position.get(node.id);
          // An agent's name is its key in the HOCON (`traveler_intake_agent`).
          // Spelled out here — including the acronyms, which a bare underscore
          // swap left as "Hr" and "Cicd" — with the key itself on hover for
          // whoever is about to go and edit that file.
          const label = displayName(node.name);
          const kind = KIND_LABEL[node.kind] || node.kind;
          return `<div class="agentnode agentnode--${esc(node.kind)}" data-node="${esc(node.id)}"
               style="left:${pos.x}%; top:${pos.y}%" tabindex="0"
               title="${esc(label === node.name ? label : `${label} · ${node.name}`)} — ${esc(kind)}"
               aria-label="${esc(label)} — ${esc(kind)}">
            <span class="agentnode__glyph" aria-hidden="true">${icon(KIND_ICON[node.kind] || 'cube', { size: 15 })}</span>
            <span class="agentnode__label">${esc(label)}</span>
          </div>`;
        }).join('')}
      </div>
      <div class="agentgraph__legend">
        <span>${icon('rocket', { size: 12 })}front-man</span>
        <span>${icon('cpu', { size: 12 })}orchestrator</span>
        <span>${icon('cube', { size: 12 })}agent</span>
        <span>${icon('external', { size: 12 })}hosted / external</span>
      </div>
    </div>`;

  const stage = $('#ag-stage', container);
  const draw = () => drawEdges(stage, edges);
  draw();
  wireTrace(stage, edges);

  let observer;
  if ('ResizeObserver' in window) {
    observer = new ResizeObserver(draw);
    observer.observe(stage);
  } else {
    window.addEventListener('resize', draw);
  }
  return () => {
    observer ? observer.disconnect() : window.removeEventListener('resize', draw);
  };
}

function drawEdges(stage, edges) {
  const svg = $('.agentgraph__edges', stage);
  const group = $('#ag-edge-paths', stage);
  const bounds = stage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);

  const boxes = new Map();
  $$('[data-node]', stage).forEach((el) => boxes.set(el.dataset.node, el.getBoundingClientRect()));

  group.replaceChildren();
  edges.forEach((edge) => {
    const from = boxes.get(edge.source);
    const to = boxes.get(edge.target);
    if (!from || !to) return;
    const sx = from.left + from.width / 2 - bounds.left;
    const sy = from.bottom - bounds.top;
    const tx = to.left + to.width / 2 - bounds.left;
    const ty = to.top - bounds.top;
    const midY = (sy + ty) / 2;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'agentedge');
    path.setAttribute('d', `M ${sx.toFixed(1)} ${sy.toFixed(1)} `
      + `C ${sx.toFixed(1)} ${midY.toFixed(1)}, ${tx.toFixed(1)} ${midY.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`);
    path.setAttribute('marker-end', 'url(#ag-arrow)');
    path.dataset.source = edge.source;
    path.dataset.target = edge.target;
    group.append(path);
  });
}

/** Hover or focus a node to trace its calls — everything unrelated recedes. */
function wireTrace(stage, edges) {
  $$('[data-node]', stage).forEach((el) => {
    const id = el.dataset.node;
    const activate = () => {
      stage.classList.add('is-tracing');
      const related = new Set([id]);
      $$('.agentedge', stage).forEach((path) => {
        const active = path.dataset.source === id || path.dataset.target === id;
        path.classList.toggle('is-active', active);
        if (active) { related.add(path.dataset.source); related.add(path.dataset.target); }
      });
      $$('[data-node]', stage).forEach((node) =>
        node.classList.toggle('is-related', related.has(node.dataset.node)));
    };
    const deactivate = () => {
      stage.classList.remove('is-tracing');
      $$('.agentedge', stage).forEach((path) => path.classList.remove('is-active'));
      $$('[data-node]', stage).forEach((node) => node.classList.remove('is-related'));
    };
    el.addEventListener('mouseenter', activate);
    el.addEventListener('focus', activate);
    el.addEventListener('mouseleave', deactivate);
    el.addEventListener('blur', deactivate);
  });
}
