/** Shared link to the authoring tool, kept identical everywhere it is offered. */
export const ACCELERATOR_URL = 'https://neuro-san.evolution.ml/multiAgentAccelerator';

export function acceleratorLink() {
  return `
    <p class="accelerator-link">
      Create/edit agentic systems in
      <a href="${ACCELERATOR_URL}" target="_blank" rel="noopener noreferrer">
        Cognizant Neuro&reg; AI Multi-Agent Accelerator
      </a>.
    </p>`;
}
