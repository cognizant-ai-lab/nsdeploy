/** Opens the "how this network is wired" modal from anywhere: the deploy
 * success panel, or the Directory table's View action. One call site for
 * fetch + loading + error handling so neither view re-implements it. */
import { api } from '../api/client.js';
import { render } from '../util/dom.js';
import { displayName } from '../util/format.js';
import { errorNote } from './widgets.js';
import { openModal } from './modal.js';
import { renderNetworkGraph } from './networkGraph.js';

export function showNetworkGraphModal(id, name) {
  let destroyGraph = null;
  openModal({
    // Titled the way the map and the directory title it — done here rather than at
    // each call site so both of them get it from one place.
    title: displayName(name),
    size: 'lg',
    render(body) {
      render(body, `<div class="stack"><div class="skeleton" style="width:45%"></div>
        <div class="skeleton" style="width:70%; height:14rem"></div></div>`);
      api.agentGraph(id).then((graph) => {
        destroyGraph = renderNetworkGraph(body, graph);
      }).catch((error) => {
        render(body, errorNote(error.message || 'Could not load this network’s diagram.'));
      });
      return () => destroyGraph?.();
    },
  });
}
